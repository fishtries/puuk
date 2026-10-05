import { Dimensions, StyleSheet } from 'react-native';

const { width, height } = Dimensions.get('window');

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000000',
  },
  safeArea: {
    alignItems: 'center',
    paddingHorizontal: 30,
    justifyContent: 'space-between',
    paddingTop: 10,
    paddingBottom: 20,
  },
  playerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    height: 40,
  },
  closeButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dragIndicator: {
    width: 40,
    height: 5,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    borderRadius: 3,
  },
  artContainer: {
    width: width - 60,
    height: width - 60,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 15,
    elevation: 10,
    marginBottom: 20,
    marginTop: 20,
  },
  trackInfoContainer: {
    width: '100%',
    marginBottom: 30,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  textContainer: {
    flex: 1,
    paddingRight: 10,
  },
  titleText: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  artistText: {
    color: '#e5e5ea',
    fontSize: 18,
    opacity: 0.8,
  },
  progressContainer: {
    width: '100%',
    paddingVertical: 10,
    marginBottom: 10,
  },
  progressBarBackground: {
    width: '100%',
    height: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderRadius: 2,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 5,
  },
  progressBarFill: {
    height: 4,
    backgroundColor: '#ffffff',
    borderRadius: 2,
    position: 'absolute',
    left: 0,
  },
  progressThumb: {
    width: 8,
    height: 8,
    backgroundColor: '#ffffff',
    borderRadius: 4,
    position: 'absolute',
    marginLeft: -4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  timeText: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 12,
    fontWeight: '500',
  },
  controlsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '80%',
    marginBottom: 30,
  },
  bottomControls: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '60%',
    marginTop: 10,
  },
  queueContainer: {
    flex: 1,
    width: '100%',
    marginTop: 20,
    marginBottom: 20,
  },
  queueTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#ffffff',
    marginBottom: 15,
  },
  normalBottomRow: {
    flexDirection: 'column',
    width: '100%',
    alignItems: 'center',
  },
  compactHandleContainer: {
    width: '100%',
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'transparent',
    marginBottom: -2,
  },
  compactHandlePill: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
  },
  compactBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    paddingHorizontal: 5,
    paddingTop: 6,
    paddingBottom: 15,
  },
  compactMediaControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    width: 'auto',
    marginBottom: 0,
  },
  compactRightControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 15,
    width: 'auto',
  },
  compactBtn: {
    padding: 5,
  },
  miniPlayerContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 64,
    backgroundColor: '#000000',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    zIndex: 30,
  },

  miniPlayerImage: {
    width: 44,
    height: 44,
    borderRadius: 8,
    backgroundColor: '#222222',
  },
  miniPlayerInfo: {
    flex: 1,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  miniPlayerTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#ffffff',
  },
  miniPlayerArtist: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.6)',
    marginTop: 2,
  },

  miniPlayerButton: {
    padding: 8,
  },
  heartBtn: {
    padding: 6,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

export default styles;
