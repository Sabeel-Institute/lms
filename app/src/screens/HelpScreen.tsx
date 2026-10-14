import { Fragment, useEffect, useState } from 'react';
import { StyleSheet, Text, View, type LayoutRectangle } from 'react-native';
import { HELP_VIDEOS, helpVideosFor, type HelpAudience, type HelpVariant, type HelpVideo } from '@sabeel/shared';
import { Empty, NavRow, Notice, RowList, Screen, SectionTitle, Segmented } from '../components/ui';
import { HelpFilm } from '../components/HelpFilm';
import { helpFilmLinks } from '../help';
import { errorText } from '../errors';
import { useWide } from '../useWidth';
import { getTheme, spacing } from '../theme';

const t = getTheme();

/**
 * Staff see every film, in this order: their own work, what a student sees,
 * and running the institute.
 */
const STAFF_SECTIONS: { audience: HelpAudience; title: string }[] = [
  { audience: 'staff', title: 'Teaching' },
  { audience: 'student', title: 'For students' },
  { audience: 'admin', title: 'Running the institute' },
];

/**
 * Help: short films of the app at work, each made on a phone and on a
 * computer. A student sees the students' films and the server signs them no
 * other. Staff see every film, the students' included, so a teacher can walk
 * a student through what the student sees.
 */
export function HelpScreen({ role, onOpen }: { role: 'student' | 'manager' | 'admin'; onOpen: (id: string) => void }) {
  const films = helpVideosFor(role);
  const rows = (list: HelpVideo[]) => (
    <RowList>
      {list.map((f) => (
        <NavRow key={f.id} testID={`help-film-${f.id}`} label={f.title} caption={f.summary} onPress={() => onOpen(f.id)} />
      ))}
    </RowList>
  );
  return (
    // No title of its own: the header says "Help".
    <Screen width="read">
      <Text style={styles.lede}>Short films of the app at work, each on a phone and on a computer.</Text>
      {role === 'student'
        ? rows(films)
        : STAFF_SECTIONS.map(({ audience, title }) => (
            <Fragment key={audience}>
              <SectionTitle>{title}</SectionTitle>
              {rows(films.filter((f) => f.audience === audience))}
            </Fragment>
          ))}
    </Screen>
  );
}

/** Each cut's shape: the phone films stand, the computer films lie down. */
const ASPECT: Record<HelpVariant, number> = { phone: 390 / 844, computer: 1440 / 900 };

/**
 * The film as large as the room under the heading holds it, WHOLE. A standing
 * film drawn at the column's width is taller than a phone's screen, and its
 * controls and the bottom of the app it shows — the bar a film is often about —
 * sat below the fold.
 */
function fit(room: LayoutRectangle, aspect: number): { width: number; height: number } {
  const width = Math.min(room.width, room.height * aspect);
  return { width, height: width / aspect };
}

/**
 * One help film. It opens on the cut for the screen it is watched on, and the
 * other is a tap away: a teacher at a computer may want to see the phone.
 */
export function HelpFilmScreen({ id }: { id: string }) {
  const film = HELP_VIDEOS.find((v) => v.id === id);
  const wide = useWide();
  const [variant, setVariant] = useState<HelpVariant>(wide ? 'computer' : 'phone');
  const [links, setLinks] = useState<Awaited<ReturnType<typeof helpFilmLinks>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unplayable, setUnplayable] = useState(false);
  const [room, setRoom] = useState<LayoutRectangle | null>(null);
  useEffect(() => {
    let live = true;
    setLinks(null);
    setError(null);
    setUnplayable(false);
    helpFilmLinks(id, variant).then(
      (l) => live && setLinks(l),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [id, variant]);
  if (!film) {
    return (
      <Screen>
        <Empty>There is no such help film.</Empty>
      </Screen>
    );
  }
  return (
    <Screen title={film.title} subtitle={film.summary} width="read" fill>
      <View style={styles.cuts}>
        <Segmented
          value={variant}
          testIdPrefix="help-cut"
          options={[
            { value: 'phone', label: 'On a phone' },
            { value: 'computer', label: 'On a computer' },
          ]}
          onChange={setVariant}
        />
      </View>
      <View style={styles.room} onLayout={(e) => setRoom(e.nativeEvent.layout)}>
        {error ? (
          <Notice tone="error">{error}</Notice>
        ) : unplayable ? (
          <Notice tone="info">This film could not be played. It may not be ready yet; try again later.</Notice>
        ) : links && room ? (
          <HelpFilm
            key={`${id}-${variant}`}
            video={links.video.url}
            captions={links.captions.url}
            size={fit(room, ASPECT[variant])}
            onError={() => setUnplayable(true)}
          />
        ) : (
          <Empty>Loading the film…</Empty>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  lede: { fontSize: 15, color: t.text.secondary, marginBottom: spacing(4) },
  cuts: { marginBottom: spacing(3) },
  room: { flex: 1, alignItems: 'center' },
});
