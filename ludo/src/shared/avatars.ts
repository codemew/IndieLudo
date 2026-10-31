/**
 * Profile avatars: animals and pets, drawn as emoji (no image files to load, and they look the
 * same on every phone's own emoji font). A player stores just the id; the server only accepts ids
 * from this list, so a name or picture can't be smuggled in. '' means no avatar: the player's
 * initial is shown instead.
 */
export interface Avatar {
  id: string;
  emoji: string;
  /** For screen readers and the tooltip. */
  name: string;
}

export const AVATARS: readonly Avatar[] = [
  { id: 'dog', emoji: '🐶', name: 'Dog' },
  { id: 'cat', emoji: '🐱', name: 'Cat' },
  { id: 'rabbit', emoji: '🐰', name: 'Rabbit' },
  { id: 'hamster', emoji: '🐹', name: 'Hamster' },
  { id: 'fox', emoji: '🦊', name: 'Fox' },
  { id: 'bear', emoji: '🐻', name: 'Bear' },
  { id: 'panda', emoji: '🐼', name: 'Panda' },
  { id: 'koala', emoji: '🐨', name: 'Koala' },
  { id: 'tiger', emoji: '🐯', name: 'Tiger' },
  { id: 'lion', emoji: '🦁', name: 'Lion' },
  { id: 'cow', emoji: '🐮', name: 'Cow' },
  { id: 'pig', emoji: '🐷', name: 'Pig' },
  { id: 'frog', emoji: '🐸', name: 'Frog' },
  { id: 'monkey', emoji: '🐵', name: 'Monkey' },
  { id: 'chicken', emoji: '🐔', name: 'Chicken' },
  { id: 'penguin', emoji: '🐧', name: 'Penguin' },
  { id: 'owl', emoji: '🦉', name: 'Owl' },
  { id: 'duck', emoji: '🦆', name: 'Duck' },
  { id: 'unicorn', emoji: '🦄', name: 'Unicorn' },
  { id: 'horse', emoji: '🐴', name: 'Horse' },
  { id: 'wolf', emoji: '🐺', name: 'Wolf' },
  { id: 'turtle', emoji: '🐢', name: 'Turtle' },
  { id: 'octopus', emoji: '🐙', name: 'Octopus' },
  { id: 'dolphin', emoji: '🐬', name: 'Dolphin' },
  { id: 'whale', emoji: '🐳', name: 'Whale' },
  { id: 'goldfish', emoji: '🐠', name: 'Goldfish' },
  { id: 'parrot', emoji: '🦜', name: 'Parrot' },
  { id: 'flamingo', emoji: '🦩', name: 'Flamingo' },
  { id: 'elephant', emoji: '🐘', name: 'Elephant' },
  { id: 'giraffe', emoji: '🦒', name: 'Giraffe' },
  { id: 'hedgehog', emoji: '🦔', name: 'Hedgehog' },
  { id: 'otter', emoji: '🦦', name: 'Otter' },
  { id: 'sloth', emoji: '🦥', name: 'Sloth' },
  { id: 'butterfly', emoji: '🦋', name: 'Butterfly' },
  { id: 'hatching', emoji: '🐣', name: 'Chick' },
  { id: 'poodle', emoji: '🐩', name: 'Poodle' },
];

const BY_ID = new Map(AVATARS.map((a) => [a.id, a]));

export function isAvatarId(id: unknown): id is string {
  return typeof id === 'string' && BY_ID.has(id);
}

export function avatarOf(id: string | null | undefined): Avatar | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** What to draw in a player's round icon: their avatar, or else their initial. */
export function avatarFace(avatar: string | null | undefined, username: string): string {
  return avatarOf(avatar)?.emoji ?? username[0]?.toUpperCase() ?? '';
}
