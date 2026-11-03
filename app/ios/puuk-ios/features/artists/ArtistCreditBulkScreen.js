import React, { useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ArtistCreditsEditor from '../../shared/components/ArtistCreditsEditor';
import {
  applyArtistReplacement,
  previewArtistReplacement,
} from '../../shared/api/artistCredits';

const names = (credits) =>
  (credits || []).map((credit) => credit.name).join(', ') || 'Нет исполнителей';

export default function ArtistCreditBulkScreen({
  route,
  navigation,
  currentUser,
}) {
  const { artistId, artistName } = route.params;
  const isAdmin = (currentUser ?? route.params.currentUser)?.role === 'admin';
  const [scope, setScope] = useState('tracks');
  const [selectors, setSelectors] = useState([]);
  const [draftArtists, setDraftArtists] = useState([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const changeScope = (next) => {
    setScope(next);
    setPreview(null);
    setResult(null);
    setError('');
  };
  const saveDraft = (next, namedDraft) => {
    setSelectors(next);
    setDraftArtists(
      namedDraft ||
        next.map((entry) => ({
          ...entry,
          name:
            entry.name ||
            draftArtists.find((artist) => artist.id === entry.id)?.name ||
            entry.id,
        })),
    );
    setPreview(null);
    setResult(null);
    setError('');
  };
  const previewChanges = async () => {
    setBusy(true);
    setError('');
    setPreview(null);
    setResult(null);
    try {
      setPreview(await previewArtistReplacement(artistId, scope, selectors));
    } catch (e) {
      setError(
        e.status === 403
          ? 'Недостаточно прав для исправления.'
          : e.message || 'Не удалось подготовить предварительный просмотр.',
      );
    } finally {
      setBusy(false);
    }
  };
  const applyChanges = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setError('');
    try {
      setResult(await applyArtistReplacement(artistId, preview.operation_id));
    } catch (e) {
      if (e.status === 409) {
        setPreview(null);
        setError(
          'Состав или список записей изменился. Подготовьте предварительный просмотр снова.',
        );
      } else
        setError(
          e.status === 403
            ? 'Недостаточно прав для исправления.'
            : e.message ||
                'Не удалось применить исправление. Повторите попытку.',
        );
    } finally {
      setBusy(false);
    }
  };
  if (!isAdmin)
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.error} accessibilityRole="alert">
          Недостаточно прав для исправления.
        </Text>
        <Button title="Назад" onPress={() => navigation.goBack()} />
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Button
          title="Назад"
          onPress={() => navigation.goBack()}
          disabled={busy}
        />
        <Text style={styles.heading}>Исправить исполнителя</Text>
        <Text style={styles.text}>
          Заменить точное совпадение: {artistName}
        </Text>
        <Text style={styles.muted}>
          Выберите отдельно треки или альбомы. Другие исполнители сохранятся.
        </Text>
        <View style={styles.row}>
          <Button
            title="Треки"
            onPress={() => changeScope('tracks')}
            selected={scope === 'tracks'}
            disabled={busy}
          />
          <Button
            title="Альбомы"
            onPress={() => changeScope('albums')}
            selected={scope === 'albums'}
            disabled={busy}
          />
        </View>
        <Text style={styles.text}>
          Новый состав:{' '}
          {draftArtists.length ? names(draftArtists) : 'удалить совпадение'}
        </Text>
        <Button
          title="Изменить состав"
          onPress={() => setEditorOpen(true)}
          disabled={busy}
        />
        <Button
          title="Предварительный просмотр"
          onPress={previewChanges}
          disabled={busy}
        />
        {!!error && (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        )}
        {busy && <ActivityIndicator accessibilityLabel="Загрузка" />}
        {preview && !result && (
          <View testID="bulk-preview">
            <Text style={styles.heading}>Предварительный просмотр</Text>
            <Text style={styles.text}>
              Найдено: {preview.matched_count} · Изменится:{' '}
              {preview.changed_count}
            </Text>
            {preview.entries.map((entry) => (
              <View
                key={`${entry.entity_type}-${entry.entity_id}`}
                style={styles.entry}
              >
                <Text style={styles.muted}>
                  {entry.entity_type === 'track' ? 'Трек' : 'Альбом'}:{' '}
                  {entry.entity_id}
                </Text>
                <Text style={styles.text}>Было: {names(entry.before)}</Text>
                <Text style={styles.text}>Станет: {names(entry.after)}</Text>
              </View>
            ))}
            <Button
              title="Применить исправление"
              onPress={applyChanges}
              disabled={busy}
            />
          </View>
        )}
        {result && (
          <View testID="bulk-result">
            <Text style={styles.text}>
              Исправление применено. Изменено: {result.changed_count}
            </Text>
            <Text style={styles.muted}>
              Профиль может исчезнуть, если у него больше нет связанных записей.
            </Text>
          </View>
        )}
      </ScrollView>
      <ArtistCreditsEditor
        visible={editorOpen}
        onClose={() => setEditorOpen(false)}
        entity={{ artists: draftArtists }}
        onSaveDraft={saveDraft}
      />
    </SafeAreaView>
  );
}
function Button({ title, onPress, disabled, selected }) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!disabled, selected: !!selected }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, selected && styles.selected]}
    >
      <Text style={styles.text}>{title}</Text>
    </TouchableOpacity>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  content: { padding: 20, paddingBottom: 50, gap: 12 },
  heading: { color: '#fff', fontSize: 22, fontWeight: '700' },
  text: { color: '#fff', fontSize: 16 },
  muted: { color: '#aaa', fontSize: 14 },
  error: { color: '#ff8888', fontSize: 16 },
  row: { flexDirection: 'row', gap: 12 },
  button: {
    padding: 12,
    minHeight: 44,
    backgroundColor: '#1c1c1e',
    borderRadius: 8,
    justifyContent: 'center',
  },
  selected: { backgroundColor: '#6043ae' },
  entry: {
    paddingVertical: 12,
    gap: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#555',
  },
});
