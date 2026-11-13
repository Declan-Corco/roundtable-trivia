# Split Decision questions

Every `.json` file in this folder is a question pack for **Split Decision**. Each round, the TV shows
one question with two answers. Everyone picks a side on their phone (nobody sees what anyone else
picked), then every table guesses what percent of the room picked the first answer. The closer the
guess, the more it scores.

New or edited files show up the next time someone opens the host screen. Hosts can also type their
own questions on the setup page: `Cats or dogs? | Cats | Dogs`, one per line.

```json
{
  "title": "Everyday Debates",
  "icon": "🛋️",
  "description": "Habits everyone has an opinion on.",
  "questions": [
    { "question": "Shower: morning or night?", "a": "Morning", "b": "Night" },
    { "question": "Do you make your bed every morning?" },
    "Have you ever broken a bone?"
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `title` | no | Name shown on the host screen (defaults to the file name). |
| `icon` | no | An emoji shown on the pack's card. |
| `description` | no | Short description. |
| `questions` | **yes** | The questions. Each is `{ "question", "a", "b" }` with its two answers (up to 24 characters each), or just the question (as text, or without `a` and `b`) for a yes / no question. |

Good questions split a room: there's no right answer, and people can't easily guess which side
most others will pick. Lopsided ones ("Can you whistle?") are fun too, because tables still have to
guess *how* lopsided.
