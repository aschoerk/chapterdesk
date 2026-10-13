import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  ChatBundle
} from '../bundle.service';

/**
 * Built-in demo workspace, embedded as a normal chapterdesk bundle.
 *
 * It is loaded automatically on a truly empty workspace (no chats, no
 * projects) so a fresh ChapterDesk install shows structure, reading and
 * editing right away — no LLM provider/model required for that. The demo
 * chats are intentionally model-free (`modelId`/`providerId` are left empty).
 *
 * Importing never happens twice: `DemoDataService` guards on a localStorage
 * marker AND on the presence of the "ChapterDesk Demo" project by name.
 */

const D  = '2026-10-13T09:00:00.000Z'; // stable timestamps keep ordering deterministic

/**
 * Demo story — a deliberately small linear story that demonstrates:
 *  - structure: system premise, directions (user) and chapters (assistant)
 *  - reading: headings, lists, a table, bold/italic, a blockquote
 *  - editing: the final empty direction is the composer the user types into
 */
const DEMO_STORY = [
  {
    id: 'dk-sys',
    parentId: null,
    role: 'system' as const,
    content:
      '# World premise\n\n' +
      'A wind-scoured harbour village where the ancient lighthouse has not ' +
      'been lit for a hundred years. Third person, literary tone, quiet ' +
      'melancholy. Themes: memory, duty and the sea.',
    version: 1,
    isCurrent: true,
    createdAt: D,
    updatedAt: D,
    position: 1
  },
  {
    id: 'dk-q1',
    parentId: 'dk-sys',
    role: 'user' as const,
    content:
      'Introduce the harbour and the keeper in an opening chapter.',
    version: 1,
    isCurrent: true,
    createdAt: D,
    updatedAt: D,
    position: 1
  },
  {
    id: 'dk-a1',
    parentId: 'dk-q1',
    role: 'assistant' as const,
    content:
      '## Chapter One · The Harbour\n\n' +
      'The village woke before the gulls. Fog pressed against the rooftops, ' +
      'and the only light for miles was the one in **Mara’s window** — a ' +
      'candle she kept beside the sea-glass jars she had never found a use ' +
      'for.\n\n' +
      'She was the keeper, though there was nothing left to keep:\n\n' +
      '- The lamp had been dark for a hundred years\n' +
      '- The key hung on a hook by the door, rusted to the shape of a wish\n' +
      '- Nobody in the village remembered why the light went out\n\n' +
      '> *A drowned sailor once said the lamp was lit by guilt. Mara thought* ' +
      '*it sounded more like a debt.*',
    version: 1,
    isCurrent: true,
    createdAt: D,
    updatedAt: D,
    position: 1
  },
  {
    id: 'dk-q2',
    parentId: 'dk-a1',
    role: 'user' as const,
    content:
      'The keeper finds a wax-sealed letter under the floorboards. Write the ' +
      'next chapter.',
    version: 1,
    isCurrent: true,
    createdAt: D,
    updatedAt: D,
    position: 1
  },
  {
    id: 'dk-a2',
    parentId: 'dk-q2',
    role: 'assistant' as const,
    content:
      '## Chapter Two · The Seal\n\n' +
      'The floorboard gave with a sound like a held breath. Under it lay a ' +
      'page, folded edge-to-edge, sealed with wax the colour of old ' +
      'sea-glass.\n\n' +
      'Mara broke the seal. The handwriting was her **mother’s** — a woman ' +
      'who had drowned before Mara could ask the questions the sea had ' +
      'already answered.\n\n' +
      '| The letter | What it says |\n' +
      '| --- | --- |\n' +
      '| First line | “Light it once, and the sea will give back what it owns.” |\n' +
      '| Second line | A date — the night of the storm |\n' +
      '| Signature | A name that was not her mother’s |\n\n' +
      'Somewhere beyond the fog, the tide leaned in. Mara reached for the ' +
      'key on the hook.',
    version: 1,
    isCurrent: true,
    createdAt: D,
    updatedAt: D,
    position: 1
  },
  {
    id: 'dk-draft',
    parentId: 'dk-a2',
    role: 'user' as const,
    content:
      '',
    version: 1,
    isCurrent: true,
    createdAt: D,
    updatedAt: D,
    position: 1
  }
];

/**
 * Demo tour — an instructional chat that explains structure, reading and
 * editing so the capabilities are discoverable WITHOUT an LLM. The final
 * empty direction is the composer; a configured model is not needed.
 */
const DEMO_TOUR = [
  {
    id: 'tour-q1',
    parentId: null,
    role: 'user' as const,
    content:
      'What is the structure of a ChapterDesk story?',
    version: 1,
    isCurrent: true,
    createdAt: D,
    updatedAt: D,
    position: 1
  },
  {
    id: 'tour-a1',
    parentId: 'tour-q1',
    role: 'assistant' as const,
    content:
      '## The section tree\n\n' +
      'Each story is a tree of **sections**. A *direction* (you) is answered ' +
      'by a *chapter* (the model), and every chapter can lead to further ' +
      'sections:\n\n' +
      '```text\n' +
      'premise (system)\n' +
      '└─ direction 1\n' +
      '   └─ chapter 1\n' +
      '      └─ direction 2\n' +
      '         └─ chapter 2  ← the active text so far\n' +
      '            └─ (composer — type your next direction here)\n' +
      '```\n\n' +
      'Roles are colour-coded in the navbar on the left of the tree, and the ' +
      '“section counter” (e.g. `1 / 2`) shows where you are among siblings.',
    version: 1,
    isCurrent: true,
    createdAt: D,
    updatedAt: D,
    position: 1
  },
  {
    id: 'tour-q2',
    parentId: 'tour-a1',
    role: 'user' as const,
    content:
      'How do I read and edit without an LLM configured?',
    version: 1,
    isCurrent: true,
    createdAt: D,
    updatedAt: D,
    position: 1
  },
  {
    id: 'tour-a2',
    parentId: 'tour-q2',
    role: 'assistant' as const,
    content:
      '## Reading\n\n' +
      'Open the **Reader view** (`Ctrl-B`) to render the story as a book: ' +
      'choose columns, typeface and size, and flip through every ' +
      'continuation path. Markdown is rendered throughout — headings, ' +
      '**bold**, *italics*, lists, tables and block quotes.\n\n' +
      '## Editing\n\n' +
      'Click any section to enter the editor — no model call needed:\n\n' +
      '- **Edit & save as new version** — the old text is kept in history\n' +
      '- **Rewrite a marked passage** — a model suggests variants, or you ' +
      'replace it with your own text\n' +
      '- **Create a continuation** — ask a question at the composer below\n' +
      '- **Branch / regenerate / delete** — from each section’s `⋮` menu\n' +
      '- **Clipboard** — copy, cut and paste whole sections\n\n' +
      'When you are ready for the AI, open **Settings → AI providers** and ' +
      'configure a provider and a model — the same models then drive ' +
      'titling, chapter descriptions, image generation and rewriting.',
    version: 1,
    isCurrent: true,
    createdAt: D,
    updatedAt: D,
    position: 1
  },
  {
    id: 'tour-draft',
    parentId: 'tour-a2',
    role: 'user' as const,
    content:
      '',
    version: 1,
    isCurrent: true,
    createdAt: D,
    updatedAt: D,
    position: 1
  }
];

export const DEMO_BUNDLE: ChatBundle = {
  format: BUNDLE_FORMAT,
  version: BUNDLE_VERSION,
  exportedAt: D,
  scope: 'topic-project',
  includeChats: true,
  topics: [
    {
      id: 'chapterdesk-demo-topic',
      name: 'ChapterDesk Demo',
      description:
        'Built-in demo workspace. Explore structure, reading and editing — no AI model configured needed.',
      defaultModelId: null,
      chatParametersId: null,
      defaultSystemPrompt: 'You are a thoughtful writing coach.',
      icon: '📖',
      projectIds: ['chapterdesk-demo-project'],
      createdAt: D,
      updatedAt: D
    }
  ],
  projects: [
    {
      id: 'chapterdesk-demo-project',
      name: 'ChapterDesk Demo',
      greeting: 'Welcome! Try the tour story, or edit the demo story to see how sections work.',
      systemPrompt:
        'You help the user draft a novel. Answer in chapters, third person, literary tone.',
      defaultModelId: null,
      chatParametersId: null,
      avatar: '',
      personaIds: ['chapterdesk-demo-persona'],
      mainTopicId: 'chapterdesk-demo-topic',
      topicIds: ['chapterdesk-demo-topic'],
      createdAt: D,
      updatedAt: D
    }
  ],
  personas: [
    {
      id: 'chapterdesk-demo-persona',
      name: 'Editor',
      shortName: 'Ed',
      description: 'A careful editor persona that helps you polish your story.',
      avatar: '',
      mainTopicId: 'chapterdesk-demo-topic',
      createdAt: D,
      updatedAt: D
    }
  ],
  chats: [
    {
      id: 'chapterdesk-demo-chat-tour',
      title: 'Reader & Editor Tour',
      projectId: 'chapterdesk-demo-project',
      chatParametersId: null,
      node_number: DEMO_TOUR.length,
      created_at: D,
      updated_at: D,
      nodes: DEMO_TOUR as ChatBundle['chats'][number]['nodes']
    },
    {
      id: 'chapterdesk-demo-chat-story',
      title: 'The Lantern Keeper',
      projectId: 'chapterdesk-demo-project',
      chatParametersId: null,
      node_number: DEMO_STORY.length,
      created_at: D,
      updated_at: D,
      nodes: DEMO_STORY as ChatBundle['chats'][number]['nodes']
    }
  ]
};