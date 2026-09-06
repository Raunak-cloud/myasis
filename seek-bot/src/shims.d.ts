// pdf-parse-fork ships no types; we only use its default export as a function.
declare module 'pdf-parse-fork' {
  const pdf: (data: Buffer) => Promise<{ text: string; numpages?: number }>;
  export default pdf;
}
