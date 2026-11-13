# Table Takedown prompts

Every `.json` file in this folder is a prompt pack for **Table Takedown**. Each round, the TV shows one
prompt, every table writes one funny answer, and everyone votes for their favourite (never their own).

New or edited files show up the next time someone opens the host screen. Hosts can also type their
own prompts on the setup page.

```json
{
  "title": "Everyday Chaos",
  "icon": "🌀",
  "description": "Pets, phones, fridges and other daily disasters.",
  "prompts": [
    "A terrible name for a pet goldfish",
    { "prompt": "The real reason the dinosaurs went extinct", "time": 90 }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `title` | no | Name shown on the host screen (defaults to the file name). |
| `icon` | no | An emoji shown on the pack's card. |
| `description` | no | Short description. |
| `prompts` | **yes** | The prompts. Each is text, or `{ "prompt": "...", "time": 90 }` to give it its own writing time in seconds. |

Good prompts are open-ended and invite a short punchline: "A terrible name for…", "The worst thing
to…", "What … is really thinking". The shipped packs suit a family crowd; answers are filtered for the
crowd the host picks (see the main README).
