import { isServerCoverUri, resolveCoverUri } from '../CoverImage';
import { SERVER_URL } from '../../utils/api';

describe('components/CoverImage utils', () => {
  describe('isServerCoverUri', () => {
    it('returns true for relative /api/cover/ endpoints', () => {
      expect(isServerCoverUri('/api/cover/62602a42-a336-5080-bc07-6634c48a3564?v=0')).toBe(true);
    });

    it('returns true for full backend cover URLs regardless of host', () => {
      expect(isServerCoverUri('https://web.puuk.fun/api/cover/62602a42-a336-5080-bc07-6634c48a3564?v=0')).toBe(true);
      expect(isServerCoverUri('http://192.168.1.117:8000/api/cover/62602a42-a336-5080-bc07-6634c48a3564')).toBe(true);
    });

    it('returns false for external third-party cover URLs', () => {
      expect(isServerCoverUri('https://e-cdns-images.dzcdn.net/images/cover/12345.jpg')).toBe(false);
      expect(isServerCoverUri('https://is1-ssl.mzstatic.com/image/thumb/Music/v4/cover.jpg')).toBe(false);
    });

    it('returns false for non-string inputs', () => {
      expect(isServerCoverUri(null)).toBe(false);
      expect(isServerCoverUri(undefined)).toBe(false);
      expect(isServerCoverUri(12345)).toBe(false);
    });
  });

  describe('resolveCoverUri', () => {
    it('normalizes foreign host to active SERVER_URL', () => {
      const input = 'https://web.puuk.fun/api/cover/62602a42-a336-5080-bc07-6634c48a3564?v=0';
      const resolved = resolveCoverUri(input);
      expect(resolved.startsWith(SERVER_URL)).toBe(true);
      expect(resolved).toBe(`${SERVER_URL}/api/cover/62602a42-a336-5080-bc07-6634c48a3564?v=0`);
    });

    it('normalizes relative /api/cover/ to active SERVER_URL', () => {
      const input = '/api/cover/test-uuid';
      const resolved = resolveCoverUri(input);
      expect(resolved).toBe(`${SERVER_URL}/api/cover/test-uuid`);
    });

    it('appends token parameter with proper separator', () => {
      const withParams = resolveCoverUri('/api/cover/test?v=1', 'my_jwt_token');
      expect(withParams).toBe(`${SERVER_URL}/api/cover/test?v=1&token=my_jwt_token`);

      const withoutParams = resolveCoverUri('/api/cover/test', 'my_jwt_token');
      expect(withoutParams).toBe(`${SERVER_URL}/api/cover/test?token=my_jwt_token`);
    });

    it('does not touch external URLs and does not leak token to them', () => {
      const external = 'https://e-cdns-images.dzcdn.net/images/cover/12345.jpg';
      const resolved = resolveCoverUri(external, 'secret_token');
      expect(resolved).toBe(external);
      expect(resolved).not.toContain('secret_token');
    });
  });
});
