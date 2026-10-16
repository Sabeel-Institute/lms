import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { Button, Card, Field, Notice, Screen } from '../components/ui';
import { useLeaveGuard } from '../components/LeaveGuard';
import { reportProblem } from '../conduct';
import { errorText } from '../errors';
import { useOneAtATime } from '../oneAtATime';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * REPORT A PROBLEM: one field, Send, nothing else.
 *
 * The person names what or who they are reporting and what is wrong, in their
 * own words; that is what lets one field report content and people alike
 * (`docs/STORE-RELEASE.md`, decision 4). The server keeps the report and
 * emails it to the administrators, who reply by email, so there is nothing
 * to show here afterwards: no history, no status, no categories.
 *
 * What is typed is not lost on the way out: Back, a tab or the browser asks
 * first (`useLeaveGuard`), and a refusal leaves the words in the field.
 */
export function ReportScreen() {
  const [text, setText] = useState('');
  const [outcome, setOutcome] = useState<'sent' | 'kept' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { active, run } = useOneAtATime();

  const guard = useLeaveGuard({
    when: text.trim() !== '',
    prompt: {
      title: 'This report is not sent',
      message: 'Leave now and what you wrote is lost.',
      stay: 'Stay',
      leave: 'Leave without sending',
    },
  });

  const send = () =>
    void run('send', async () => {
      setError(null);
      setOutcome(null);
      try {
        const mail = await reportProblem(text);
        setText('');
        // Failed is the email alone: the report is kept, and Sentry has the reason.
        setOutcome(mail === 'failed' ? 'kept' : 'sent');
      } catch (e) {
        setError(errorText(e));
      }
    });

  return (
    <Screen title="Report a problem">
      {guard.element}
      <Card>
        <Text style={styles.lede}>
          Tell the institute’s administrators about something or someone in the app. They receive it by email with your
          name and email address, and reply within a day.
        </Text>
        <Field
          testID="report-text"
          label="What or who are you reporting, and what is wrong?"
          value={text}
          onChangeText={(v) => {
            setText(v);
            if (outcome) setOutcome(null);
          }}
          multiline
        />
        {outcome === 'sent' ? <Notice tone="success">Sent. An administrator will reply by email within a day.</Notice> : null}
        {outcome === 'kept' ? (
          <Notice tone="info">Your report was saved but the email did not go out; it will be looked at.</Notice>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button testID="report-send" label="Send" busy={active === 'send'} onPress={send} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  lede: { fontSize: 15, lineHeight: 22, color: t.text.primary, marginBottom: spacing(3) },
});
