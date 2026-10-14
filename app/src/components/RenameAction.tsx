import { useState } from 'react';
import { Sheet } from './Sheet';
import { Button, Field, IconButton, Notice } from './ui';
import { errorText } from '../errors';
import { useOneAtATime } from '../oneAtATime';

/**
 * A page's name, changed from a pencil beside its title: a sheet holding the
 * name and Save. The field is seeded from the LIVE name each time it opens, so
 * it never offers back a name somebody else has changed since — and a field on
 * the page itself, seeded once, did exactly that.
 */
export function RenameAction({
  name,
  label,
  testID,
  onSave,
}: {
  name: string;
  /** "Rename cohort": the pencil's name, and the sheet's title. */
  label: string;
  /** The field's id; the pencil is `<testID>-open` and Save `<testID>-save`. */
  testID: string;
  onSave: (name: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const { active, run } = useOneAtATime();
  const trimmed = draft.trim();
  return (
    <>
      <IconButton
        testID={`${testID}-open`}
        icon="edit"
        label={label}
        bare
        onPress={() => {
          setDraft(name);
          setError(null);
          setOpen(true);
        }}
      />
      <Sheet visible={open} title={label} onClose={() => setOpen(false)} closeLabel="Cancel">
        <Field testID={testID} label="Name" value={draft} onChangeText={setDraft} autoCapitalize="words" />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button
          testID={`${testID}-save`}
          label="Save"
          block
          busy={active !== null}
          // Nothing to save until the name differs: a Save that writes the same
          // name again is a button that does nothing.
          disabled={!trimmed || trimmed === name}
          onPress={() =>
            void run('save', async () => {
              setError(null);
              try {
                await onSave(trimmed);
                setOpen(false);
              } catch (e) {
                setError(errorText(e));
              }
            })
          }
        />
      </Sheet>
    </>
  );
}
