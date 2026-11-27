import { z } from "zod";

export const toolOutputSchema = z.object({ data: z.unknown() });

export function toolResult(data: unknown) {
  let text: string;
  try {
    text = JSON.stringify(data);
  } catch {
    text = "Google Health returned a result that could not be serialized.";
  }
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { data },
  };
}
