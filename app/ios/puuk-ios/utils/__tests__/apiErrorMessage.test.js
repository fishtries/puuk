import { parseApiErrorMessage } from '../api';

describe('parseApiErrorMessage', () => {
  it('handles null, undefined and empty inputs with fallback', () => {
    expect(parseApiErrorMessage(null)).toBe('An error occurred');
    expect(parseApiErrorMessage(undefined, 'Custom fallback')).toBe('Custom fallback');
    expect(parseApiErrorMessage({}, 'Custom fallback')).toBe('Custom fallback');
  });

  it('handles direct string input', () => {
    expect(parseApiErrorMessage('Raw string error')).toBe('Raw string error');
  });

  it('handles detail as string', () => {
    expect(parseApiErrorMessage({ detail: 'Track not found' })).toBe('Track not found');
  });

  it('handles FastAPI validation error array without returning [object Object]', () => {
    const pydanticError = {
      detail: [
        {
          loc: ['body', 'cover_url'],
          msg: "Value error, cover_base64 and cover_url must be null when cover_action is 'keep'",
          type: 'value_error',
        },
      ],
    };
    const message = parseApiErrorMessage(pydanticError);
    expect(message).toBe("Value error, cover_base64 and cover_url must be null when cover_action is 'keep'");
    expect(message).not.toContain('[object Object]');
  });

  it('handles multiple validation errors in detail array', () => {
    const multiError = {
      detail: [
        { loc: ['body', 'title'], msg: 'Title is required' },
        { loc: ['body', 'year'], msg: 'Year must be a number' },
      ],
    };
    const message = parseApiErrorMessage(multiError);
    expect(message).toBe('Title is required\nYear must be a number');
    expect(message).not.toContain('[object Object]');
  });

  it('handles object detail gracefully', () => {
    expect(parseApiErrorMessage({ detail: { message: 'Object error message' } })).toBe('Object error message');
    expect(parseApiErrorMessage({ detail: { msg: 'Msg in object' } })).toBe('Msg in object');
  });

  it('falls back to message property if detail is missing', () => {
    expect(parseApiErrorMessage({ message: 'Top-level message' })).toBe('Top-level message');
  });
});
