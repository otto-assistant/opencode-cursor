import { randomInt } from "node:crypto";
import { deflateSync } from "node:zlib";

/** Labels stay in the host verifier; the model receives only PNG pixels. */
export function imageTrial() {
  const palette = [
    ["RED", 230, 20, 20],
    ["GREEN", 20, 180, 20],
    ["BLUE", 20, 20, 230],
  ];
  const left = randomInt(palette.length);
  const right = (left + 1 + randomInt(2)) % palette.length;
  const chosen = [palette[left], palette[right]];
  const width = 320,
    height = 160;
  const pixels = Buffer.alloc(height * (1 + width * 3), 255);
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    pixels[row] = 0;
    for (let x = 0; x < width; x++)
      if (
        y >= 20 &&
        y < 140 &&
        ((x >= 20 && x < 140) || (x >= 180 && x < 300))
      ) {
        const color = chosen[x < 160 ? 0 : 1];
        for (let channel = 0; channel < 3; channel++)
          pixels[row + 1 + x * 3 + channel] = color[channel + 1];
      }
  }
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length);
    body.copy(out, 4);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
    return out;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return {
    answer: chosen.map(([name]) => name).join(","),
    png: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(pixels)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  };
}
