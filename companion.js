// The Claude button: builds a message with your request, your plot and your text,
// copies it, and opens Claude, where your Pro plan covers it. Nothing is sent from this app.
import { parsePlot } from './plot.js';

const MAX_TEXT_WORDS = 4000;
const MAX_PLOT_WORDS = 1500;

export const HELP = [
  {
    id: 'check',
    name: 'Check my writing',
    hint: 'Grammar, clarity, flow, tense and word choice',
    ask: 'Check my writing for spelling, grammar, clarity, flow, tense slips and word choice. List each problem with the fix, in the order it appears. Keep my voice, and don’t rewrite the whole thing.',
  },
  {
    id: 'next',
    name: 'What happens next?',
    hint: 'A few options to pick from',
    ask: 'Give me 3 to 5 options for what could happen next, each in 2 or 3 sentences, that move toward this section’s goal. Don’t write the scene. I’ll write it.',
  },
  {
    id: 'unstuck',
    name: 'Get me unstuck',
    hint: 'Questions and one small next step',
    ask: 'I’m stuck. Ask me 3 short questions that help me find what this scene needs, then give me one small next step I could write in the next 10 minutes.',
  },
  {
    id: 'setting',
    name: 'Describe the setting',
    hint: 'Details to use, not finished prose',
    ask: 'Help me describe the setting of this scene. Give me sensory details (sight, sound, smell, touch, temperature) as a short list I can pick from, not finished prose.',
  },
  {
    id: 'dialogue',
    name: 'Punch up the dialogue',
    hint: 'Sharper lines in each character’s voice',
    ask: 'Punch up the dialogue in my text. Point to the weakest lines and suggest sharper versions that keep each character’s voice. Show each one as before → after.',
  },
  {
    id: 'edit',
    name: 'Edit what I wrote',
    hint: 'Line edits, shown as before and after',
    ask: 'Do an edit pass on my text: line edits for clarity, rhythm and word choice. Show the changes as before → after, and explain the big ones briefly. Keep my voice.',
  },
  {
    id: 'continue',
    name: 'Draft the next bit',
    hint: 'Claude writes a short passage for you to rewrite',
    ask: 'Draft the next 150 to 250 words in my style, toward this section’s goal. Label it “Claude’s draft” so I can rewrite it in my own words.',
  },
  {
    id: 'ask',
    name: 'Something else',
    hint: 'Type your question below',
    ask: '',
  },
];

const ROLE = [
  'You’re my writing companion for my story. I’m the main writer, and you help me get there:',
  'ideas, options, questions and edits. Only write story text when I ask for it, and label it so I can rewrite it in my own words.',
  'Keep your answer focused and short enough to read on my phone.',
].join(' ');

function words(text) {
  return text.match(/\S+/g) ?? [];
}

// Keeps the end of long text, since the part near the cursor matters most.
function lastWords(text, limit) {
  const all = words(text);
  if (all.length <= limit) return { text: text.trim(), cut: false };
  const keep = all.slice(-limit).join(' ');
  const start = text.lastIndexOf(keep.slice(0, 40));
  return { text: (start >= 0 ? text.slice(start) : keep).trim(), cut: true };
}

function firstWords(text, limit) {
  const all = words(text);
  if (all.length <= limit) return text.trim();
  return `${all.slice(0, limit).join(' ')} …`;
}

export function countWords(text) {
  return words(text).length;
}

// What the request will include, for the line at the top of the Claude box.
export function scopeLabel({ selection, page, plotText, section }) {
  const parts = [];
  if (selection.trim()) parts.push(`your selected text (${countWords(selection).toLocaleString()} words)`);
  else parts.push(`“${page.name}” (${countWords(page.text).toLocaleString()} words${countWords(page.text) > MAX_TEXT_WORDS ? `, the last ${MAX_TEXT_WORDS.toLocaleString()}` : ''})`);
  if (plotText?.trim()) parts.push(section ? `your plot and the section “${section.title}”` : 'your plot');
  return `Claude will get ${parts.join(' and ')}.`;
}

export function buildRequest({ helpId, note, story, page, selection, plotText, section }) {
  const help = HELP.find(item => item.id === helpId) ?? HELP[0];
  const out = [ROLE, ''];
  out.push(`## What I need`);
  if (help.ask) out.push(help.ask);
  if (note?.trim()) out.push(help.ask ? `Also: ${note.trim()}` : note.trim());
  if (!help.ask && !note?.trim()) out.push('Read what I wrote and tell me what’s working and what isn’t.');
  out.push('', `## My story: ${story}`);
  const plot = plotText?.trim() ? parsePlot(plotText) : null;
  if (plot) {
    if (plot.premise) out.push(`Premise: ${plot.premise}`);
    if (plot.sections.length) {
      out.push('Sections:');
      plot.sections.forEach((item, i) => {
        const mark = item.title === section?.title ? ' ← I’m here' : (item.status === 'done' ? ' (written)' : '');
        out.push(`${i + 1}. ${item.title}${item.goal ? `: ${item.goal.replace(/\s*\n\s*/g, ' ')}` : ''}${mark}`);
      });
    } else {
      out.push(firstWords(plotText, MAX_PLOT_WORDS));
    }
  }
  if (section) {
    out.push('', `## The section I’m on: ${section.title}`);
    if (section.goal) out.push(`Goal: ${section.goal}`);
    if (section.prompt) out.push(`What I’m writing toward: ${section.prompt}`);
  }
  const chosen = selection?.trim() ? { text: selection.trim(), cut: false } : lastWords(page.text, MAX_TEXT_WORDS);
  out.push('', selection?.trim() ? `## The part I selected from “${page.name}”` : `## My text: “${page.name}”`);
  if (chosen.cut) out.push(`(This is the last ${MAX_TEXT_WORDS.toLocaleString()} words. The page starts earlier.)`);
  out.push(chosen.text || '(I haven’t written anything on this page yet.)');
  return out.join('\n');
}

export const PLOT_FORMAT = `# Plot: <story name>

## Premise
<one paragraph about the story>

## Sections

### 1. <section title>
Status: todo
Page: Chapter 1
Goal: <one sentence: what happens in this section>
Prompt: <2 to 4 sentences that tell me what to write toward in this section: the moment to reach, what the character wants, and a detail to include. Don't write the scene.>

### 2. <section title>
Status: todo
Page: Chapter 2
Goal: …
Prompt: …`;

export function buildPlotRequest({ story, plotText, pages }) {
  const out = [
    ROLE,
    '',
    '## What I need',
    `Help me plan the plot for my story “${story}”. Interview me first: ask me a few questions at a time about the characters, what they want, the setting and how the story ends, until you have enough. Then suggest a plot as an ordered list of sections (chapters or scenes), and let me change it.`,
    '',
    'When we agree, give me the plot in exactly this Markdown format, in one code block, so I can paste it into my writing app. Use “Status: todo” for sections I haven’t written. Use “Page: Chapter N” for each section, matching my page names where they exist.',
    '',
    '```markdown',
    PLOT_FORMAT,
    '```',
  ];
  if (pages.length) out.push('', `My pages in this story so far: ${pages.map(page => `${page.name} (${countWords(page.text).toLocaleString()} words)`).join(', ')}.`);
  if (plotText?.trim()) out.push('', '## My plot so far', firstWords(plotText, MAX_PLOT_WORDS * 2));
  return out.join('\n');
}

// Takes the plot out of a pasted Claude reply: the Markdown code block if there is one.
export function extractPlot(pasted) {
  const text = (pasted ?? '').replace(/\r\n/g, '\n');
  const block = /```(?:markdown|md)?\s*\n([\s\S]*?)\n```/i.exec(text);
  const inner = block ? block[1] : text;
  return inner.trim() ? `${inner.trim()}\n` : '';
}
