#!/usr/bin/env node
// Tries the Only One Claude check on a few tricky rounds and shows what Claude decided.
//
//   cd /opt/roundtable/server && sudo node scripts/try-claude-check.js
//   sudo AI_CHECK_MODEL=claude-sonnet-5-5 node scripts/try-claude-check.js   # try another model
//
// Uses ANTHROPIC_API_KEY from the environment, or from /etc/roundtable.env. Costs about a quarter of a cent.
const fs = require('fs');

if (!process.env.ANTHROPIC_API_KEY) {
  try {
    for (const line of fs.readFileSync('/etc/roundtable.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*(ANTHROPIC_API_KEY|AI_CHECK_MODEL)\s*=\s*(.*?)\s*$/);
      if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* no settings file here */
  }
}
const aicheck = require('../src/aicheck');
if (!aicheck.enabled()) {
  console.error('No ANTHROPIC_API_KEY found (set it, or put it in /etc/roundtable.env and run this with sudo).');
  process.exit(1);
}

// Each round: the answers (each starts in its own group, unless listed together) and what a fair referee would do.
const ROUNDS = [
  {
    category: "Things you shouldn't say on a first date",
    groups: [
      ['How cheap was that dress?'], ['How much makeup did you put on?'], ['I hate you'], ['You look great'], ["You're ugly"],
      ['Your breath smells'], ['Nice to meet you'], ['I still live with my mom'], ['My ex was better'], ['Thanks for coming'],
    ],
    misfits: ['You look great', 'Nice to meet you', 'Thanks for coming'],
  },
  {
    category: 'Things a superhero needs',
    groups: [['cape'], ['mask'], ['grappling hook'], ['gun', 'laser gun'], ['banana'], ['utility belt'], ['spreadsheet'], ['a sidekick'], ['secret identity']],
    misfits: ['banana', 'spreadsheet'],
  },
  {
    category: 'Chip flavors',
    groups: [['Barbecue'], ['Cheese'], ['Cookies and Cream'], ['Cool ranch'], ['Plain'], ['Sour cream'], ['Spicy Nacho'], ['dill pickle'], ['ketchup'], ['salt and vinegar'], ['mint chocolate chip']],
    misfits: ['Cookies and Cream', 'mint chocolate chip'],
  },
  {
    category: 'Ice cream flavors',
    groups: [['cookies and cream'], ['mint chocolate chip'], ['vanilla'], ['rocky road'], ['barbecue'], ['strawberry'], ['salt and vinegar']],
    misfits: ['barbecue', 'salt and vinegar'],
  },
  {
    category: 'Things in a dorm room',
    groups: [['mini fridge'], ['Keurig'], ['coffee maker'], ['couch'], ['volcano'], ['string lights'], ['giraffe'], ['bunk bed']],
    misfits: ['volcano', 'giraffe'],
    merges: [['Keurig', 'coffee maker']],
  },
];

(async () => {
  let cost = 0;
  let right = 0;
  let wrong = 0;
  for (const round of ROUNDS) {
    let n = 0;
    const text = {};
    const groups = round.groups.map((answers, i) => ({
      id: `g${i + 1}`,
      entries: answers.map((t) => {
        const id = `a${++n}`;
        text[id] = t;
        return { id, text: t };
      }),
    }));
    const groupText = Object.fromEntries(groups.map((g) => [g.id, g.entries.map((e) => e.text).join(' + ')]));
    const r = await aicheck.check(round.category, groups);
    cost += aicheck.costOf(r.usage);
    const rejected = r.misfits.map((m) => text[m.id]);
    console.log(`\n"${round.category}"  (${(r.ms / 1000).toFixed(1)} s, ~$${aicheck.costOf(r.usage).toFixed(5)}, judged ${r.judged}/${r.total})`);
    for (const m of r.misfits) console.log(`   ✕ ${text[m.id]}  — ${m.why}`);
    for (const set of r.merge) console.log(`   = merged: ${set.map((g) => groupText[g]).join('  |  ')}`);
    for (const id of r.split) console.log(`   ÷ split out: ${text[id]}`);
    for (const want of round.misfits) {
      const ok = rejected.includes(want);
      ok ? right++ : wrong++;
      console.log(`   ${ok ? 'ok  ' : 'MISS'} should reject "${want}"`);
    }
    for (const got of rejected.filter((t) => !round.misfits.includes(t))) {
      wrong++;
      console.log(`   WRONG rejected "${got}", which fits`);
    }
    for (const pair of round.merges || []) {
      const ok = r.merge.some((set) => pair.every((t) => set.some((g) => groupText[g].includes(t))));
      ok ? right++ : wrong++;
      console.log(`   ${ok ? 'ok  ' : 'MISS'} should merge ${pair.join(' + ')}`);
    }
  }
  console.log(`\n${right} right, ${wrong} wrong · total ~$${cost.toFixed(4)} for ${ROUNDS.length} rounds (model ${process.env.AI_CHECK_MODEL || 'claude-haiku-5-5'})`);
})().catch((err) => {
  console.error('Check failed:', err.message);
  process.exit(1);
});
