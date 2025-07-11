// Provides functions to summarize content using Instructor and Ollama with structured output and proper message roles.

import { z } from 'zod';
import { SingleBar, Presets } from 'cli-progress';
import Instructor from '@instructor-ai/instructor';
import { Article, OllamaConfig } from '../types/index';

// Define the structured schema based on the desired multi-line output format
const StructuredSummarySchema = z.object({
  thinking: z
    .string()
    .describe(
      'Think step-by-step to analyze the content and plan the summary.'
    ),
  context: z.string().describe('Context of the article.'),
  core_idea: z.string().describe('Core idea of the article.'),
  insight_1: z.string().describe('First main insight.'),
  insight_2: z.string().describe('Second main insight.'),
  insight_3: z.string().describe('Third main insight.'),
  insight_4: z.string().describe('Fourth main insight.'),
  insight_5: z.string().describe('Fifth main insight.'),
  author_conclusion: z.string().describe("Author's conclusion or final point."),
});

export const createArticleSummarizer = (
  client: ReturnType<typeof Instructor>,
  config: OllamaConfig,
  // Default schema is now the structured one
  schema: z.AnyZodObject = StructuredSummarySchema
) => {
  const MAX_CONTENT_LENGTH = config.maxContentLength;
  const MAX_OUTPUT_TOKENS = config.maxSummaryLength; // Increased slightly for structured output
  // NUM_CTX is guaranteed to be a number by the config loader
  const NUM_CTX = config.numCtx;
  const MIN_CONTENT_LENGTH = 300;

  // Escape HTML chars to avoid prompt injection.
  const sanitizeInput = (text: string) =>
    text.replace(
      /[<>&]/g,
      (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] || c)
    );

  // Redact IPs and handle captcha flags.
  const sanitizeSummary = (summary: string): string =>
    /captcha/i.test(summary)
      ? 'No summary available'
      : summary.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, 'REDACTED');

  // Strip any “Label:” prefixes (e.g. “Context:”, “Core idea:”) from each line.
  const stripLabels = (text: string): string =>
    text
      .split('\n')
      .map((line) => line.replace(/^\s*\w+:\s*/, ''))
      .join('\n');

  // Collapse multiple blank lines into a single newline.
  const collapseBlankLines = (text: string): string =>
    text.replace(/\n\s*\n+/g, '\n');

  // Capture the model name for metadata.
  const modelName = config.model;

  // Summarize a single article's content.
  const summarizeContent = async (
    title: string,
    content: string
  ): Promise<string> => {
    if (!content || content.trim().length < MIN_CONTENT_LENGTH) {
      return 'No summary available';
    }

    const truncatedContent = content.slice(0, MAX_CONTENT_LENGTH);
    const truncationNotice =
      content.length > MAX_CONTENT_LENGTH
        ? '\n[Truncated for length constraints]'
        : '';

      const systemPrompt = `
You are a helpful assistant summarizing Hacker News articles. Follow these instructions precisely:
- Use the 'thinking' field to think step-by-step about the content before generating the summary fields. This field will not be part of the final output.
- Return "No summary available" if content is missing, unreadable, or you cannot extract the required fields.
- NEVER hallucinate; summarize only the provided content.
- Extract the following fields based on the content:
  * context: Provide the context.
  * core_idea: State the core idea.
  * insight_1: Detail the first main insight.
  * insight_2: Detail the second main insight.
  * insight_3: Detail the third main insight.
  * insight_4: Detail the fourth main insight.
  * insight_5: Detail the fifth main insight.
  * author_conclusion: Describe the author's conclusion.
- Use a neutral, factual tone suitable for a tech audience.
- Respond ONLY with the structured data requested.
      `.trim();

      const userPrompt = `
<title>${sanitizeInput(title)}</title>
<content>${sanitizeInput(truncatedContent)}${truncationNotice}</content>
      `.trim();

    try {
      const response = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.2, // Keep low for factual summary
        top_p: 0.9,
        // Pass Ollama-specific options, ensuring NUM_CTX is defined
        options: {
          num_ctx: NUM_CTX, // NUM_CTX is defined above with env/config/fallback logic
        },
        // Use the structured schema for the response model
        response_model: { schema: StructuredSummarySchema, name: 'StructuredSummary' },
      });

      // Type assertion for the structured response
      const structuredSummary = response as z.infer<typeof StructuredSummarySchema>;

      // Check if essential fields are present
      if (
        !structuredSummary.context?.trim() ||
        !structuredSummary.core_idea?.trim()
      ) {
        console.warn(`Missing essential fields for title: ${title}`);
        return 'No summary available';
      }

      // Combine the structured fields (excluding 'thinking') into the desired multi-line format
      const combinedSummary = [
        structuredSummary.context,
        structuredSummary.core_idea,
        structuredSummary.insight_1,
        structuredSummary.insight_2,
        structuredSummary.insight_3,
        structuredSummary.insight_4,
        structuredSummary.insight_5,
        structuredSummary.author_conclusion,
      ]
        .map((line) => line?.trim() || '') // Trim each line, handle potential undefined/null
        .filter((line) => line.length > 0) // Remove empty lines if any field was empty/missing
        .join('\n');

      if (!combinedSummary) {
        return 'No summary available';
      }

      // Apply existing post-processing (sanitization, label stripping, line collapsing)
      const sanitized = sanitizeSummary(combinedSummary);
      const labeledStripped = stripLabels(sanitized); // May not be needed now, but kept for safety
      return collapseBlankLines(labeledStripped);
    } catch (error) {
      console.error(`Error summarizing article "${title}":`, error);
      return 'No summary available';
    }
  };

  // Summarize an array of articles with a progress bar.
  const summarizeArticles = async (articles: Article[]): Promise<Article[]> => {
    const bar = new SingleBar(
      {
        format: 'Summarizing Articles |{bar}| {percentage}% | {value}/{total}',
      },
      Presets.shades_classic
    );
    bar.start(articles.length, 0);

    for (let i = 0; i < articles.length; i++) {
      articles[i].summary = await summarizeContent(
        articles[i].title,
        articles[i].content || ''
      );
      articles[i].modelName = modelName;
      bar.update(i + 1);
    }

    bar.stop();
    return articles;
  };

  return { summarizeArticles };
};
