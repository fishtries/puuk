import { StyleSheet } from 'react-native';

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#0B0B0D' },
  backButton: {
    width: 48,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  pageTitle: {
    color: '#fff',
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -0.8,
    marginBottom: 24,
  },
  scrollContent: { paddingHorizontal: 20, paddingTop: 8 },
  customColor: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#434348',
    borderWidth: 1,
    borderColor: '#bbb',
  },
  // ── Profile Card ──
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1C1C1E',
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#2C2C2E',
  },
  avatarCircle: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#2C2C2E',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
    borderWidth: 2,
  },
  profileInfo: {
    flex: 1,
  },
  profileUsername: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  roleBadge: {
    backgroundColor: '#2C2C2E',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  roleText: {
    color: '#8E8E93',
    fontSize: 11,
    fontWeight: '600',
  },
  syncBadge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  syncText: {
    color: '#34C759',
    fontSize: 11,
    fontWeight: '500',
  },

  // ── Unauthenticated Card ──
  unauthCard: {
    backgroundColor: '#1C1C1E',
    borderRadius: 16,
    padding: 16,
    marginBottom: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#2C2C2E',
  },
  segmentedControl: {
    flexDirection: 'row',
    backgroundColor: '#121214',
    borderRadius: 12,
    padding: 3,
    marginBottom: 14,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 9,
  },
  segmentBtnActive: {
    backgroundColor: '#2C2C2E',
  },
  segmentText: {
    color: '#8E8E93',
    fontSize: 13,
    fontWeight: '600',
  },
  segmentTextActive: {
    color: '#FFF',
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 69, 58, 0.15)',
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },
  errorText: {
    color: '#FF453A',
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
  },
  tabBody: {
    gap: 10,
  },
  hintText: {
    color: '#8E8E93',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 4,
  },
  input: {
    backgroundColor: '#1C1C1E',
    color: '#FFF',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#2C2C2E',
  },
  actionBtn: {
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 6,
  },
  actionBtnDisabled: {
    opacity: 0.6,
  },
  actionBtnText: {
    color: '#000',
    fontSize: 15,
    fontWeight: '700',
  },

  // ── Settings Sections (iOS Inset Grouped) ──
  sectionHeader: {
    color: '#8E8E93',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginLeft: 6,
    marginTop: 4,
  },
  groupCard: {
    backgroundColor: '#1C1C1E',
    borderRadius: 16,
    paddingHorizontal: 14,
    marginBottom: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#2C2C2E',
  },
  rowItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
  },
  rowDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    marginLeft: 40,
  },
  rowIconBox: {
    width: 28,
    height: 28,
    borderRadius: 7,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  rowLabel: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '500',
    flex: 1,
  },
  rowValue: {
    color: '#8E8E93',
    fontSize: 14,
    marginRight: 6,
  },

  // ── Color Palette ──
  colorPalette: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  colorDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  colorDotActive: {
    borderWidth: 2.5,
    borderColor: '#FFF',
    transform: [{ scale: 1.15 }],
  },

  storageSummary: { paddingVertical: 16 },
  storageBar: {
    flexDirection: 'row',
    height: 10,
    borderRadius: 5,
    overflow: 'hidden',
    backgroundColor: '#363639',
    marginVertical: 12,
  },
  legendRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4, marginRight: 10 },

  // ── Version Footer ──
  versionText: {
    color: '#636366',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 8,
  },
});

export default styles;
