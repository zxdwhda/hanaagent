import type { EditorOptions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Bold } from '@tiptap/extension-bold';
import Placeholder, { type PlaceholderOptions } from '@tiptap/extension-placeholder';
import { SkillBadge } from './extensions/skill-badge';
import { FileBadge } from './extensions/file-badge';
import { SessionBadge } from './extensions/session-badge';
import { AgentBadge } from './extensions/agent-badge';

export type InputEditorPlaceholder = PlaceholderOptions['placeholder'];

const ChatInputBold = Bold.extend({
  inclusive: false,
  keepOnSplit: false,
});

export function createInputEditorOptions(placeholder: InputEditorPlaceholder): Pick<EditorOptions, 'extensions' | 'enablePasteRules'> {
  return {
    // The send serializer ignores inline text marks. Paste rules would consume
    // literal code or Markdown delimiters before that text reaches the model.
    enablePasteRules: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        dropcursor: false,
        gapcursor: false,
        link: false,
        bold: false,
      }),
      ChatInputBold,
      Placeholder.configure({ placeholder }),
      SkillBadge,
      FileBadge,
      SessionBadge,
      AgentBadge,
    ],
  };
}
