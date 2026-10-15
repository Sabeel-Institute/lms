import { describe, expect, it } from 'vitest';
import { withoutIds } from './withoutIds';

describe('a page address in a crash report', () => {
  it('names nobody: account and document ids become :id, the route stays', () => {
    expect(
      withoutIds('https://oursabeel-lms.web.app/courses/1yh8aRB2KTdiSt195SCo/assignments/EGXCPeelkmZ2yILwyssq/grade/NRegLM5fOdbae025f76B95gD47p2'),
    ).toBe('https://oursabeel-lms.web.app/courses/:id/assignments/:id/grade/:id');
    expect(withoutIds('https://oursabeel-lms.web.app/students/NRegLM5fOdbae025f76B95gD47p2?tab=history')).toBe(
      'https://oursabeel-lms.web.app/students/:id?tab=history',
    );
    expect(withoutIds('https://oursabeel-lms.web.app/play/ge7rfY9ED6TQJaRsyjKQ#t')).toBe('https://oursabeel-lms.web.app/play/:id#t');
  });

  it('keeps words and the site itself', () => {
    expect(withoutIds('https://oursabeel-lms.web.app/courses')).toBe('https://oursabeel-lms.web.app/courses');
    expect(withoutIds('https://oursabeel-lms.web.app/more/help')).toBe('https://oursabeel-lms.web.app/more/help');
  });
});
