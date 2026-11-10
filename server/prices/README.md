# Sticker Shock packs

Each `.json` file here is a category for **Sticker Shock**. Players type a number on their phone. The closest guess **without going over** wins 1,000 points (1,500 if it's exact). Other guesses under the price score up to 500, the closer the better. Guesses over the price score nothing.

```json
{
  "title": "Bar Menu",
  "description": "What things cost right here.",
  "defaultTime": 30,
  "prefix": "$",
  "questions": [
    { "question": "A pitcher of house beer", "answer": 14, "note": "Menu price, November 2026" },
    { "question": "Our wings, 20 pieces", "answer": 24.99 },
    { "question": "Population of Tuscaloosa", "answer": 110000, "prefix": "", "suffix": "people" }
  ]
}
```

- `answer` is the real number. Decimals are fine (`24.99`).
- `prefix` and `suffix` are shown around the number on the phones and the TV, e.g. `"$"` and `"billion"`. Set them once for the whole pack, or per question to override.
- `note` (optional) is shown with the answer, for the source or date of a price. Prices change, so dating them helps.
- `time` and `points` (`"standard"`, `"double"` or `"none"`) work per question, as they do in trivia.
- Questions don't have to be prices: any number works (years, populations, calories).
- New files show up the next time someone opens the host screen.
