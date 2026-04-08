# opencode-cursor-oauth

## Персона
```
memory_read {"label":"persona","scope":"global"}
```
Користувач: Сергій / Serhii

## Проект
Плагін для OpenCode, який підключає Cursor API через OAuth, discovery моделей та локальний OpenAI-сумісний проксі.

## Архітектура

```
OpenCode → localhost proxy (Bun.serve) → h2-bridge (Node.js child process) → Cursor gRPC API (api2.cursor.sh)
```

- `src/proxy.ts` — основний файл: локальний проксі, переклад OpenAI ↔ Cursor protobuf, стрімінг, tool calling
- `src/h2-bridge.mjs` — Node.js child process для HTTP/2 (Bun's node:http2 зламаний)
- `src/models.ts` — discovery моделей через GetUsableModels RPC
- `src/auth.ts` — OAuth PKCE flow + token refresh
- `src/index.ts` — plugin entry point, реєстрація в OpenCode
- `src/proto/agent_pb.ts` — згенеровані protobuf схеми Cursor Agent API

## Workflow: розробка → білд → go live

1. **Зміни** → редагуєш `src/`
2. **Білд**: `bun run build`
3. **Тести**: `bun run test`
4. **Інстал**: `npm install -g .`
5. **Перезапуск kimaki** — обов'язково! Kimaki спавнить свій opencode-процес, який завантажує плагін при старті. Node.js кешує import/require, тому без перезапуску працює стара версія.
   ```
   kimaki restart
   ```
6. **Перевірка**: після перезапуску почекати ~10с, потім відправити тестове повідомлення в Discord

### ⚠️ Критично
- **НЕ** перезапускати kimaki без білду+інсталу — буде стара версія
- **НЕ** забувати `npm install -g .` — білд оновлює `dist/`, але opencode читає з `node_modules/opencode-cursor-oauth`
- Після перезапуску kimaki поточна сесія вмирає — нова автоматично створюється при наступному повідомленні

## Відомі проблеми та оптимізації

### Затримки виконання (досліджено 2026-04-01)
Основні джерела затримок (5хв через kimaki vs <1хв напряму через Cursor):
1. **Spawn Node.js процесу на кожен запит** (~300-500ms) — поки не виправлено, потребує connection pooling
2. **Модель пробує нативні Cursor-тулси** → rejected → retry (~3-10с на tool call) — **виправлено**: додано MCP-only інструкції в RequestContext
3. **KV handshake round-trip** (~100-300ms) — поки не виправлено
4. **Пересеріалізація conversation state** (~20-80ms для довгих сесій) — частково оптимізовано: кеш system prompt blob

### Native tools rejection
Усі нативні Cursor-тулси (read, ls, grep, shell, write, delete, fetch, diagnostics, backgroundShellSpawn, writeShellStdin) відхиляються з причиною "Tool not available". Модель має використовувати MCP-тулси (OpenCode tools).

## Ключові патерни коду

### Mutex на розмову
`convMutexes` — серіалізує запити для однієї розмови, щоб уникнути "Blob not found" помилок при конкурентних state mutations.

### Bridge lifecycle
- `activeBridges` — живі H2 з'єднання для tool call continuation
- `conversationStates` — checkpoints + blob stores для розмов (TTL 30 хв)
- Heartbeat кожні 5с щоб з'єднання не падало

### Thinking tag filter
Моделі можуть повертати `<think/>` теги — `createThinkingTagFilter()` буферизує partial tags між чанками.
