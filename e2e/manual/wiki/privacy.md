# Privacy

ChapterDesk is **local-first**. Your stories and settings stay on your
machine.

## Local desktop app

- The locally installed app does **not** collect, track, transmit or monetize
  any personal data, telemetry or usage metrics.
- All application data, story projects, workspace files and local database
  records remain stored exclusively on your device.
- Data is stored in SQLite in your user data directory:
  - Linux: `~/.config/ChapterDesk/data/chapterdesk.sqlite`
  - Windows: `%APPDATA%\ChapterDesk\data\chapterdesk.sqlite`

## Language models

If you connect to a third-party LLM provider (OpenRouter, OpenAI, Gemini,
Anthropic, or any custom OpenAI-compatible endpoint):

- Prompt payload data is transmitted **directly from your client to those
  endpoints** when you send a direction.
- Those requests are governed solely by the privacy policies of the respective
  API providers.
- ChapterDesk does **not** route your requests through its own intermediary
  servers.

The full policy lives in the repository at
[`PRIVACY.md`](https://github.com/aschoerk/chapterdesk/blob/main/PRIVACY.md).

For questions, open an issue in the
[GitHub repository](https://github.com/aschoerk/chapterdesk/issues).