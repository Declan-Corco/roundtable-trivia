# Only One categories

Every `.json` file in this folder is a category pack for **Only One**. Each round, the TV shows one
prompt from the packs the host ticked, and every table types as many answers as it can. Answers that
another table also wrote score nothing; answers only one table thought of score 100.

New or edited files show up the next time someone opens the host screen. Hosts can also type their
own prompts on the setup page.

```json
{
  "title": "College Life",
  "icon": "🎓",
  "description": "Dorms, classes, campus and late nights.",
  "prompts": [
    "Things in a dorm room",
    "College majors",
    { "prompt": "Excuses for missing class", "time": 90 }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `title` | no | Name shown on the host screen (defaults to the file name). |
| `icon` | no | An emoji shown on the pack's card. |
| `description` | no | Short description. |
| `prompts` | **yes** | The prompts. Each is text, or `{ "prompt": "...", "time": 90 }` to give it its own time in seconds. |

Good prompts have lots of possible answers, so tables have room to find ones nobody else thought of.
