// The plot planner reads a story's plot.md (format: "Plot format.md" in the project folder).
// Edits change only the lines they need to, so notes Claude or you add anywhere in the file are kept.
//
//   # Plot: My story
//   ## Premise
//   One paragraph about the story.
//   ## Sections
//   ### 1. The letter
//   Status: done            (todo, writing or done)
//   Page: Chapter 1         (the page you write this section on)
//   Goal: Mara finds her brother's letter.
//   Prompt: What to write toward. It can run over
//   several lines, until the next field or heading.

export const PLOT_NAME = 'plot';

const SECTION = /^###\s+(.*?)\s*#*\s*$/;
const HEADING = /^#{1,3}\s/;
const FIELD = /^\s*(?:[-*]\s+)?(?:\*\*|__)?(status|page|goal|prompt)(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*?)\s*$/i;
const LABELS = { status: 'Status', page: 'Page', goal: 'Goal', prompt: 'Prompt' };

export function isPlotName(name) {
  return (name ?? '').trim().toLowerCase() === PLOT_NAME;
}

export function newPlot(story) {
  return `# Plot: ${story}\n\n## Premise\n\n\n## Sections\n`;
}

function normalStatus(value) {
  const text = (value ?? '').toLowerCase();
  if (/done|complete|finished|✓|✔|\[x\]/.test(text)) return 'done';
  if (/writ|progress|draft|current|start|doing/.test(text)) return 'writing';
  return 'todo';
}

function cleanTitle(raw) {
  return raw.replace(/^(?:section|chapter|scene|part)?\s*\d+\s*[.):-]\s*/i, '').replace(/[*_`]/g, '').trim() || raw.trim();
}

export function parsePlot(text) {
  const lines = (text ?? '').split('\n');
  const plot = { title: '', premise: '', sections: [] };
  let premiseFrom = -1;
  lines.forEach((line, i) => {
    if (!plot.title && /^#\s+/.test(line)) plot.title = line.replace(/^#\s+/, '').replace(/^plot\s*:\s*/i, '').trim();
    if (premiseFrom < 0 && /^##\s+(premise|about|summary|logline|story)\b/i.test(line)) premiseFrom = i + 1;
  });
  if (premiseFrom >= 0) {
    const paragraph = [];
    for (let i = premiseFrom; i < lines.length && !HEADING.test(lines[i]); i += 1) {
      if (lines[i].trim()) paragraph.push(lines[i].trim());
      else if (paragraph.length) break;
    }
    plot.premise = paragraph.join(' ');
  }
  for (let i = 0; i < lines.length; i += 1) {
    const match = SECTION.exec(lines[i]);
    if (!match) continue;
    let end = i + 1;
    while (end < lines.length && !HEADING.test(lines[end])) end += 1;
    plot.sections.push(readSection(lines, i, end, match[1]));
  }
  return plot;
}

function readSection(lines, start, end, rawTitle) {
  const section = {
    index: 0, start, end, title: cleanTitle(rawTitle), rawTitle,
    status: 'todo', page: '', goal: '', prompt: '', fields: {},
  };
  for (let i = start + 1; i < end; i += 1) {
    const match = FIELD.exec(lines[i]);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (section.fields[key]) continue; // first one wins
    let last = i;
    const parts = [match[2]];
    if (key === 'prompt' || key === 'goal') {
      // The value runs on over the next lines, until a field, a heading or (for goals) a blank line.
      for (let j = i + 1; j < end && !FIELD.test(lines[j]); j += 1) {
        if (key === 'goal' && !lines[j].trim()) break;
        parts.push(lines[j]);
        if (lines[j].trim()) last = j;
      }
    }
    section.fields[key] = { line: i, last };
    section[key] = parts.slice(0, last - i + 1).join('\n').trim();
  }
  section.status = normalStatus(section.status);
  section.page = section.page.replace(/[*_`[\]]/g, '').replace(/\.md$/i, '').trim();
  return section;
}

export function withIndexes(plot) {
  plot.sections.forEach((section, index) => { section.index = index; });
  return plot;
}

export function sectionForPage(plot, pageName) {
  const name = (pageName ?? '').trim().toLowerCase();
  return plot.sections.find(section => section.page.toLowerCase() === name) ?? null;
}

export function nextSection(plot, after = -1) {
  return plot.sections.find((section, index) => index > after && section.status !== 'done')
    ?? plot.sections.find(section => section.status !== 'done')
    ?? null;
}

// Edits. Each takes the plot.md text and returns the changed text.

function oneLine(value) {
  return (value ?? '').replace(/\s*\n\s*/g, ' ').trim();
}

function blockLines(value) {
  // Lines that start with # would turn into headings, so drop those marks.
  return (value ?? '').trim().split('\n').map(line => line.replace(/^\s*#+\s*/, ''));
}

function setField(lines, section, key, value) {
  const label = LABELS[key];
  const field = section.fields[key];
  const newLines = key === 'prompt'
    ? [`${label}: ${blockLines(value)[0] ?? ''}`, ...blockLines(value).slice(1)]
    : [`${label}: ${oneLine(value)}`];
  if (field) {
    lines.splice(field.line, field.last - field.line + 1, ...newLines);
    return;
  }
  if (!value) return;
  // New fields go after the heading, in the usual order.
  const order = ['status', 'page', 'goal', 'prompt'];
  let at = section.start + 1;
  for (const earlier of order.slice(0, order.indexOf(key))) {
    const before = section.fields[earlier];
    if (before) at = Math.max(at, before.last + 1);
  }
  lines.splice(at, 0, ...newLines);
}

function edit(text, index, change) {
  const plot = parsePlot(text);
  const section = plot.sections[index];
  if (!section) return text;
  const lines = text.split('\n');
  change(lines, section);
  return lines.join('\n');
}

export function setStatus(text, index, status) {
  return edit(text, index, (lines, section) => setField(lines, section, 'status', status));
}

export function setPage(text, index, page) {
  return edit(text, index, (lines, section) => setField(lines, section, 'page', page));
}

export function updateSection(text, index, { title, goal, prompt, page }) {
  // Work from the last field up, so earlier line numbers stay right.
  let result = text;
  for (const [key, value] of [['prompt', prompt], ['goal', goal], ['page', page]]) {
    result = edit(result, index, (lines, section) => {
      if ((section[key] ?? '') !== (value ?? '').trim()) setField(lines, section, key, value ?? '');
    });
  }
  return edit(result, index, (lines, section) => {
    const cleanNew = oneLine(title);
    if (!cleanNew || cleanNew === section.title) return;
    const number = /^((?:section|chapter|scene|part)?\s*\d+\s*[.):-]\s*)/i.exec(section.rawTitle)?.[1] ?? '';
    lines[section.start] = `### ${number}${cleanNew}`;
  });
}

export function addSection(text, { title, goal, prompt, page }) {
  const plot = parsePlot(text);
  let result = (text ?? '').replace(/\s*$/, '\n');
  if (!/^##\s+sections\b/im.test(result) && plot.sections.length === 0) result += '\n## Sections\n';
  const lines = [`### ${plot.sections.length + 1}. ${oneLine(title) || 'New section'}`, 'Status: todo'];
  if (page) lines.push(`Page: ${oneLine(page)}`);
  if (goal) lines.push(`Goal: ${oneLine(goal)}`);
  if (prompt) {
    const promptLines = blockLines(prompt);
    lines.push(`Prompt: ${promptLines[0]}`, ...promptLines.slice(1));
  }
  return `${result}\n${lines.join('\n')}\n`;
}

export function removeSection(text, index) {
  return edit(text, index, (lines, section) => {
    let end = section.end;
    // Take the blank lines after it too.
    while (end < lines.length && !lines[end].trim() && end > section.start) end += 1;
    lines.splice(section.start, end - section.start);
  });
}
