# Split Decision packs

Each `.json` file here is a category for **Split Decision**. Everyone picks A or B, then guesses what percentage of the room picked A. Guesses score 1,000 points minus 25 for every percentage point they're off, and the closest guess gets 250 more.

The format matches Majority Rules packs, but every question has **exactly two answers**:

```json
{
  "title": "Down South",
  "description": "Southern food fights and game-day debates.",
  "defaultTime": 20,
  "questions": [
    { "question": "Waffle House or Whataburger?", "answers": ["Waffle House", "Whataburger"] }
  ]
}
```

- Give players about 20 seconds: they pick a side, then move a slider.
- `time` and `points` (`"standard"`, `"double"` or `"none"`) work per question, as they do in trivia.
- The best questions split a room roughly in half, or are lopsided in a way people misjudge.
- New files show up the next time someone opens the host screen.
