export interface SavedConnectionSecret {
  targetId: string;
  value: string;
}

export function savedSecretForTarget(secret: SavedConnectionSecret | undefined, targetId: string): string | undefined {
  return secret?.targetId === targetId && secret.value ? secret.value : undefined;
}
