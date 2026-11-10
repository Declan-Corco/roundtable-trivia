# Majority Rules packs

Each `.json` file here is a category for **Majority Rules**. In this game there are no right answers. You score by picking what most of the table picked.

The format matches trivia sets, but **without `correct`**:

```json
{
  "title": "This or That",
  "description": "Everyday dilemmas.",
  "defaultTime": 15,
  "questions": [
    { "question": "Cats or dogs?", "answers": ["Cats", "Dogs", "Both", "Neither"] }
  ]
}
```

- Each question has 2 to 4 answers. They show as A, B, C and D.
- `time` and `points` (`"standard"`, `"double"` or `"none"`) work per question, as they do in trivia.
- New files show up the next time someone opens the host screen.
