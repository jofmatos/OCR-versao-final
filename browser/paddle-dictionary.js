// The SDK reserves CTC class 0 itself and appends the space character.
// The distributor's dictionary includes a leading empty CTC entry; passing
// that entry to the SDK shifts every recognized character by one position.
export function parsePaddleDictionary(bytes) {
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  if (!lines.length || lines.some((line) => line === "")) throw new Error("O dicionário de OCR contém entradas inválidas.");
  return lines;
}
