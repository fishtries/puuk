import React, { useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { getArtists } from '../api/artists';
import { setAlbumArtists, setTrackArtists } from '../api/artistCredits';

export default function ArtistCreditsEditor({ visible, onClose, entity, entityId, scope, onSaved, onSaveDraft }) {
  const [draft, setDraft] = useState([]);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(null);
  const [busy, setBusy] = useState(false);
  const open = () => {
    setDraft((entity?.artists || []).map(({ id, name }) => ({ id, name })));
    setRevision(entity?.artists_revision ?? 0);
    setQuery(''); setResults([]); setError(''); setConflict(null);
  };
  const add = (item) => {
    if (!draft.some((entry) => (item.id && entry.id === item.id) || entry.name === item.name)) setDraft([...draft, item]);
    setQuery(''); setResults([]);
  };
  const move = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= draft.length) return;
    const next = [...draft]; [next[index], next[target]] = [next[target], next[index]]; setDraft(next);
  };
  const search = async () => {
    if (!query.trim()) return;
    setBusy(true); setError('');
    try { setResults(await getArtists(query)); } catch (e) { setError(e.message || 'Не удалось найти исполнителей'); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError('');
    try {
      const input = draft.map((item) => item.id ? { id: item.id } : { name: item.name });
      if (onSaveDraft) { onSaveDraft(input, draft.map((item) => ({ ...item }))); onClose(); return; }
      const result = scope === 'track' ? await setTrackArtists(entityId, input, revision) : await setAlbumArtists(entityId, input, revision);
      onSaved(scope === 'track' ? result : result.album);
      onClose();
    } catch (e) {
      if (e.code === 'artists_revision_conflict') setConflict({ artists: e.artists || [], revision: e.current_revision });
      else setError(e.message || 'Не удалось сохранить состав');
    } finally { setBusy(false); }
  };
  return <Modal visible={visible} onShow={open} onRequestClose={onClose} animationType="slide">
    <View style={styles.container}>
      <Text style={styles.heading}>Исполнители</Text>
      <Text style={styles.text}>Состав сохраняется в Puuk отдельно и не меняет аудиофайлы.</Text>
      <ScrollView keyboardShouldPersistTaps="handled">
        {draft.map((item, index) => <View style={styles.row} key={item.id || item.name}>
          <Text style={[styles.text, styles.name]}>{item.name}</Text>
          <Button label={`Поднять ${item.name}`} title="↑" onPress={() => move(index, -1)} />
          <Button label={`Опустить ${item.name}`} title="↓" onPress={() => move(index, 1)} />
          <Button label={`Удалить ${item.name}`} title="×" onPress={() => setDraft(draft.filter((_, i) => i !== index))} />
        </View>)}
        <TextInput accessibilityLabel="Поиск исполнителя" style={styles.input} value={query} onChangeText={setQuery} placeholder="Имя исполнителя" placeholderTextColor="#888" />
        <Button title="Найти" onPress={search} disabled={busy} />
        {results.map((item) => <Button key={item.id} title={`Добавить ${item.name}`} onPress={() => add({ id: item.id, name: item.name })} />)}
        {!!query.trim() && <Button title={`Добавить новое имя: ${query.trim()}`} onPress={() => add({ name: query.trim() })} />}
        {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        {conflict && <View><Text accessibilityRole="alert" style={styles.error}>Состав изменился на сервере: {conflict.artists.map((a) => a.name).join(', ') || 'нет исполнителей'}. Ваш черновик сохранён.</Text><Button title="Обновить ревизию и продолжить правку" onPress={() => { setRevision(conflict.revision); setConflict(null); }} /></View>}
      </ScrollView>
      {busy && <ActivityIndicator />}
      <Button title="Сохранить состав в Puuk" onPress={save} disabled={busy || !!conflict} />
      <Button title="Отмена" onPress={onClose} disabled={busy} />
    </View>
  </Modal>;
}
function Button({ title, label, onPress, disabled }) { return <TouchableOpacity accessibilityRole="button" accessibilityLabel={label || title} disabled={disabled} onPress={onPress} style={styles.button}><Text style={styles.text}>{title}</Text></TouchableOpacity>; }
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: '#000', padding: 24, paddingTop: 60 }, heading: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 12 }, text: { color: '#fff', fontSize: 16 }, row: { flexDirection: 'row', alignItems: 'center' }, name: { flex: 1 }, button: { padding: 12, minHeight: 44, justifyContent: 'center' }, input: { color: '#fff', backgroundColor: '#222', padding: 12, borderRadius: 8, marginTop: 16 }, error: { color: '#ff8888', padding: 12 } });
