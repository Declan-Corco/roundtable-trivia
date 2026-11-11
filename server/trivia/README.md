# Trivia sets

Every `.json` file in this folder is a trivia set. The file name (minus `.json`) is the set's ID.
New or edited files show up the next time someone opens the host screen — **no restart needed**.

Hosts can also upload a `.json` file straight from their own computer on the host screen
(disable this with `ALLOW_UPLOADS=false`).

## Format

```json
{
  "title": "My Quiz",
  "description": "Optional one-liner shown on the host screen.",
  "defaultTime": 20,
  "questions": [
    {
      "question": "What is 2 + 2?",
      "answers": ["3", "4", "5", "22"],
      "correct": 1
    },
    {
      "question": "Pick the even numbers",
      "answers": ["2", "3", "8", "9"],
      "correct": [0, 2],
      "time": 30,
      "points": "double",
      "image": "/media/numbers.png"
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `title` | no | Name shown on the host screen (defaults to the file name). |
| `description` | no | Short description. |
| `defaultTime` | no | Seconds per question when a question has no `time` (default 20, range 5–240). |
| `questions[].question` | **yes** | The question text (max 300 characters). |
| `questions[].answers` | **yes** | 2 to 4 answers. Use `["True", "False"]` for true/false. |
| `questions[].correct` | **yes** | Index of the right answer, **counting from 0** (first answer = 0). Use an array like `[0, 2]` when several answers are right. |
| `questions[].time` | no | Seconds for this question. |
| `questions[].points` | no | `"standard"` (default), `"double"` (a right answer wins twice the bet), or `"none"` (practice question: nothing is won or lost). |
| `questions[].category` | no | The category players see before they bet. Defaults to the set's `title`. |
| `questions[].image` | no | An `https://` image URL, or `/media/<file>` for an image placed in `trivia/media/`. |

## Scoring

Everyone starts with 1,000 points. Before each question, players see its category and bet some or
all of their points (they can always bet up to 500, even with fewer points). A right answer wins
the bet, doubled for `"double"` questions. A wrong answer, or no answer, loses it. Scores never go
below 0.
