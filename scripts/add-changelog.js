#!/usr/bin/env node

/**
 * Changelog Entry Generator for HaloTaskPro
 * Usage: node scripts/add-changelog.js
 * 
 * This script helps you add structured entries to the .logs file
 * and optionally updates docs/logs.md
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { insertChangelogEntry } = require('./changelog-markdown');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const CATEGORIES = [
  'Frontend',
  'Backend',
  'Docs',
  'Config',
  'CI/CD',
  'Ops',
  'Planning',
  'Refactor',
  'Bugfix',
  'Feature',
  'Performance',
  'Accessibility'
];

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function addChangelog() {
  console.log('\n📝 HaloTaskPro Changelog Entry Generator\n');
  
  // Show categories
  console.log('Available categories:');
  CATEGORIES.forEach((cat, i) => console.log(`  ${i + 1}. ${cat}`));
  
  const categoryChoice = await question('\nSelect category (number): ');
  const category = CATEGORIES[parseInt(categoryChoice) - 1];
  
  if (!category) {
    console.log('❌ Invalid category');
    rl.close();
    return;
  }
  
  const date = new Date().toISOString().split('T')[0];
  const title = await question('Title: ');
  const description = await question('Description: ');
  const filesStr = await question('Files affected (comma-separated, optional): ');
  const files = filesStr.split(',').map(f => f.trim()).filter(f => f);
  const priority = await question('Priority (low/medium/high, default: medium): ') || 'medium';
  
  // Create entry
  const entry = {
    date,
    category,
    title,
    description,
    files,
    priority,
    status: 'completed'
  };
  
  // Prepare the human-readable Markdown update before writing either file.
  const docsPath = path.join(__dirname, '../docs');
  let markdownUpdate = null;
  if (fs.existsSync(docsPath)) {
    const logsMarkdownPath = path.join(docsPath, 'logs.md');
    if (fs.existsSync(logsMarkdownPath)) {
      const markdown = fs.readFileSync(logsMarkdownPath, 'utf8');
      markdownUpdate = {
        path: logsMarkdownPath,
        content: insertChangelogEntry(markdown, entry)
      };
    }
  }

  // Read and update the machine-readable .logs file.
  const logsPath = path.join(__dirname, '../.logs');
  const logsData = JSON.parse(fs.readFileSync(logsPath, 'utf8'));
  logsData.entries.unshift(entry);
  logsData.lastUpdated = new Date().toISOString();
  fs.writeFileSync(logsPath, JSON.stringify(logsData, null, 2));

  // Keep docs/logs.md in the same readable, month-grouped format.
  if (markdownUpdate) {
    fs.writeFileSync(markdownUpdate.path, markdownUpdate.content);
  }

  console.log('\n✅ Changelog entry added!');
  console.log(`   Category: ${category}`);
  console.log(`   Title: ${title}`);
  console.log(`   Date: ${date}`);
  console.log(`   Priority: ${priority}`);
  
  rl.close();
}

addChangelog().catch(console.error);
