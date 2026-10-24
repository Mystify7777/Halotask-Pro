'use strict';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

const MONTH_HEADING = /^### (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})$/;
const ENTRY_DATE = /^\*\*(\d{4}-\d{2}-\d{2}) ·/;

function monthKey(year, monthName) {
  return Number(year) * 12 + MONTHS.indexOf(monthName);
}

function readMonthHeading(line, index) {
  const match = line.match(MONTH_HEADING);
  return match ? { index, key: monthKey(match[2], match[1]) } : null;
}

function insertChangelogEntry(markdown, entry) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('A changelog entry is required');
  }

  const { date, title, category, description } = entry;
  const status = entry.status || 'completed';
  const priority = entry.priority || 'medium';

  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new TypeError('Changelog date must be a valid YYYY-MM-DD date');
  }
  if (![title, category, description].every(value => typeof value === 'string' && value.trim())) {
    throw new TypeError('Changelog title, category, and description are required');
  }

  const dateObject = new Date(date + 'T00:00:00Z');
  const monthName = MONTHS[dateObject.getUTCMonth()];
  const year = dateObject.getUTCFullYear();
  const targetKey = monthKey(year, monthName);
  const monthLabel = `### ${monthName} ${year}`;
  const lines = markdown.split('\n');

  let monthIndex = lines.findIndex(line => line === monthLabel);
  if (monthIndex === -1) {
    const monthHeadings = lines
      .map(readMonthHeading)
      .filter(Boolean);
    const nextOlderMonth = monthHeadings.find(heading => heading.key < targetKey);

    if (nextOlderMonth) {
      monthIndex = nextOlderMonth.index;
    } else {
      monthIndex = lines.findIndex(line => line === '## Categories');
      if (monthIndex === -1) monthIndex = lines.length;
    }

    lines.splice(monthIndex, 0, monthLabel, '');
    monthIndex = lines.findIndex(line => line === monthLabel);
  }

  let sectionEnd = lines.length;
  for (let index = monthIndex + 1; index < lines.length; index += 1) {
    if (MONTH_HEADING.test(lines[index]) || lines[index] === '## Categories' || lines[index] === '## See Also') {
      sectionEnd = index;
      break;
    }
  }

  const entryIndexes = [];
  for (let index = monthIndex + 1; index < sectionEnd; index += 1) {
    if (lines[index].startsWith('#### ')) entryIndexes.push(index);
  }

  let insertionIndex = sectionEnd;
  for (const index of entryIndexes) {
    let existingDate = null;
    for (let cursor = index + 1; cursor < Math.min(index + 5, sectionEnd); cursor += 1) {
      const match = lines[cursor].match(ENTRY_DATE);
      if (match) {
        existingDate = match[1];
        break;
      }
    }
    if (existingDate && existingDate <= date) {
      insertionIndex = index;
      break;
    }
  }

  const block = [
    `#### ${title.trim()}`,
    '',
    `**${date} · ${category.trim()} · ${status} · Priority: ${priority}**`,
    '',
    description.trim(),
    ''
  ];
  lines.splice(insertionIndex, 0, ...block);

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

module.exports = { insertChangelogEntry };
