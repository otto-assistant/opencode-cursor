import { Plugin } from "@opencode/plugin";
import {
  createCursorCatalogState,
  registerCursorCatalog,
} from "../../dist/opencode/catalog.js";
import { registerCursorLanguage } from "../../dist/opencode/language.js";
import { stopCursorTransport } from "../../dist/cursor-agent.js";

export default Plugin.define({
  id: "test.cursor-host-boundary",
  async setup(context) {
    const selection = {
      publicId: "fixture-composer-max",
      modelId: "fixture-composer",
      displayName: "Synthetic Composer",
      parameters: [{ id: "effort", value: "max" }],
      maxMode: true,
    };
    await registerCursorCatalog(
      context,
      createCursorCatalogState([
        {
          id: "fixture-composer",
          name: "Synthetic Composer",
          reasoning: true,
          contextWindow: 200_000,
          maxTokens: 4096,
          defaultSelection: selection,
          variants: {},
        },
        {
          id: "fixture-composer-large",
          name: "Synthetic Composer 1M",
          reasoning: true,
          contextWindow: 1_000_000,
          maxTokens: 4096,
          defaultSelection: selection,
          variants: {},
        },
      ]),
    );
    await context.provider.transform((editor) => {
      editor.update("cursor", (provider) => {
        provider.activation = "enabled";
      });
    });
    await registerCursorLanguage(context, async () => "synthetic-cursor-token");
    // The fixture deliberately drops a Run, then resumes it with user steering.
    await context.session.hook("retry", (event) => {
      event.decision = { retry: false };
    }, { providerID: "cursor" });
    await context.session.hook("compaction", (event) => {
      event.system.push({ type: "text", text: "CURSOR_FIXTURE_COMPACTION" });
    }, { providerID: "cursor" });
    const startedB = Promise.withResolvers<void>();
    await context.tool.transform((tools) => {
      for (const name of ["boundary_a", "boundary_b"])
        tools.add({
          name,
          description: "Offline synchronization fixture",
          input: { type: "object", properties: {} },
          options: { codemode: false },
          async execute() {
            if (name === "boundary_a") {
              let deadline: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  startedB.promise,
                  new Promise<never>((_, reject) => {
                    deadline = setTimeout(
                      () => reject(new Error("Tools did not overlap")),
                      5000,
                    );
                  }),
                ]);
              } finally {
                clearTimeout(deadline);
              }
            } else startedB.resolve();
            return {
              content:
                name === "boundary_a"
                  ? "nonce-a-from-real-host-tool"
                  : "nonce-b-from-real-host-tool",
            };
          },
        });
    });
    return () => stopCursorTransport();
  },
});
