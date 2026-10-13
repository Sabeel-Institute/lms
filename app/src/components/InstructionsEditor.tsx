import { Field } from './ui';

/**
 * Where a teacher writes an assignment's instructions. Stored as markdown in
 * the five-element vocabulary of `@sabeel/shared/richtext` and rendered by
 * `RichText`.
 *
 * A plain text box for now: the formatting editor (bold, italic, two kinds of
 * list, links), ported from the Kanban app, replaces it in step A5b of
 * docs/plans/ASSIGNMENTS.md without the form changing.
 */
export function InstructionsEditor({ value, onChange }: { value: string; onChange: (markdown: string) => void }) {
  return <Field testID="coursework-instructions" label="Instructions" value={value} onChangeText={onChange} multiline />;
}
