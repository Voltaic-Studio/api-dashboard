export type MethodColor = {
  bg: string;
  text: string;
};

export const METHOD_COLORS: Record<string, MethodColor> = {
  GET:     { bg: '#FF9500', text: '#ffffff' },
  POST:    { bg: '#34C759', text: '#ffffff' },
  PUT:     { bg: '#007AFF', text: '#ffffff' },
  PATCH:   { bg: '#AF52DE', text: '#ffffff' },
  DELETE:  { bg: '#FF3B30', text: '#ffffff' },
  HEAD:    { bg: '#8E8E93', text: '#ffffff' },
  OPTIONS: { bg: '#8E8E93', text: '#ffffff' },
};

export function getMethodColor(method: string): MethodColor {
  return METHOD_COLORS[method.toUpperCase()] ?? { bg: '#8E8E93', text: '#ffffff' };
}
