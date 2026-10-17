import { z } from 'zod';
import { listTemplates, renderTemplate, matchIntent, fillVars } from '../templates.js';
import { runTool } from './shared.js';

export function registerTemplateTools(server, dir) {
  server.registerTool(
    'list_prompt_templates',
    {
      title: 'List prompt templates',
      description: 'List analysis/indicator/backtest prompt templates with triggers, variables and styles.',
      inputSchema: {},
    },
    async () =>
      runTool(() =>
        listTemplates(dir).map(({ id, title, triggers, vars, input_styles, output_styles, default_input_style, default_output_style }) => ({
          id, title, triggers, vars, input_styles, output_styles, default_input_style, default_output_style,
        }))
      )
  );

  server.registerTool(
    'get_prompt_template',
    {
      title: 'Get prompt template',
      description:
        'Render a prompt template to follow. Pass id, or the user\'s raw text to route by intent (id wins). Returns the instructions plus the tool/script hints.',
      inputSchema: {
        id: z.string().optional().describe('Template id, e.g. "analysis", "indicator", "backtest".'),
        text: z.string().optional().describe('The user\'s message; used to pick the template when id is omitted.'),
        input_style: z.string().optional(),
        output_style: z.string().optional(),
        vars: z.record(z.union([z.string(), z.number()])).optional().describe('Template variables, e.g. {"symbol":"BTC/USDT"}.'),
      },
    },
    async ({ id, text, input_style, output_style, vars }) =>
      runTool(() => {
        const picked = id ?? (text ? matchIntent(text, dir) : null);
        if (!picked) throw new Error(`No template matched; valid ids: ${listTemplates(dir).map((t) => t.id).join(', ')}`);
        const r = renderTemplate(picked, { inputStyle: input_style, outputStyle: output_style, vars }, dir);
        const hints = [`Template: ${r.meta.id}`, r.meta.tool && `Tool: ${r.meta.tool}`, r.meta.script && `Script: ${fillVars(r.meta.script, r.vars)}`];
        return `${r.text}\n\n---\n${hints.filter(Boolean).join('\n')}`;
      })
  );

  for (const meta of listTemplates(dir)) {
    const argsSchema = Object.fromEntries(
      Object.entries(meta.vars ?? {}).map(([name, spec]) => {
        const s = z.string().describe(spec.description ?? name);
        return [name, spec.required ? s : s.optional()];
      })
    );
    server.registerPrompt(meta.id, { title: meta.title, description: meta.title, argsSchema }, (args) => ({
      messages: [{ role: 'user', content: { type: 'text', text: renderTemplate(meta.id, { vars: args }, dir).text } }],
    }));
  }
}
