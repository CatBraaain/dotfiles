export interface RepetitionMatch {
  period: number;
  repetitions: number;
  repeatedCharacters: number;
  endPosition: number;
}

export function createRepetitionDetector() {
  const maxPeriod = 500;
  const recentCharacters = new Uint32Array(maxPeriod);
  const positionsByCharacter = new Map<number, Set<number>>();
  const consecutiveMatches = new Uint16Array(maxPeriod + 1);
  const lastMatchPositions = new Float64Array(maxPeriod + 1);
  let position = 0;
  let pendingHighSurrogate: number | undefined;
  let match: RepetitionMatch | undefined;

  function consumeCharacter(character: number): void {
    position++;
    const previousPositions = positionsByCharacter.get(character);
    let shortestPeriod = Infinity;
    let repetitions = 0;
    if (previousPositions) {
      for (const previousPosition of previousPositions) {
        const period = position - previousPosition;
        const matchingLength =
          lastMatchPositions[period] === position - 1 ? consecutiveMatches[period]! + 1 : 1;
        consecutiveMatches[period] = matchingLength;
        lastMatchPositions[period] = position;
        const completeCopies = Math.floor((matchingLength + period) / period);
        const isEligible = completeCopies >= 10 && completeCopies * period >= 1000;
        if (isEligible && period < shortestPeriod) {
          shortestPeriod = period;
          repetitions = completeCopies;
        }
      }
    }
    if (shortestPeriod !== Infinity) {
      match = {
        period: shortestPeriod,
        repetitions,
        repeatedCharacters: shortestPeriod * repetitions,
        endPosition: position,
      };
      return;
    }

    const slot = (position - 1) % maxPeriod;
    if (position > maxPeriod) {
      const expiredCharacter = recentCharacters[slot]!;
      const expiredPositions = positionsByCharacter.get(expiredCharacter)!;
      expiredPositions.delete(position - maxPeriod);
      if (expiredPositions.size === 0) positionsByCharacter.delete(expiredCharacter);
    }
    recentCharacters[slot] = character;
    let positions = positionsByCharacter.get(character);
    if (!positions) {
      positions = new Set<number>();
      positionsByCharacter.set(character, positions);
    }
    positions.add(position);
  }

  function push(delta: string): RepetitionMatch | undefined {
    if (match || delta.length === 0) return match;
    let offset = 0;
    if (pendingHighSurrogate !== undefined) {
      const nextUnit = delta.charCodeAt(0);
      if (isLowSurrogate(nextUnit)) {
        consumeCharacter(combineSurrogates(pendingHighSurrogate, nextUnit));
        offset = 1;
      } else {
        consumeCharacter(pendingHighSurrogate);
      }
      pendingHighSurrogate = undefined;
    }
    while (offset < delta.length && !match) {
      const character = delta.codePointAt(offset)!;
      const isTrailingHighSurrogate =
        character >= 0xd800 && character <= 0xdbff && offset === delta.length - 1;
      if (isTrailingHighSurrogate) {
        pendingHighSurrogate = character;
        break;
      }
      consumeCharacter(character);
      offset += character > 0xffff ? 2 : 1;
    }
    return match;
  }

  function finish(): RepetitionMatch | undefined {
    if (!match && pendingHighSurrogate !== undefined) {
      consumeCharacter(pendingHighSurrogate);
      pendingHighSurrogate = undefined;
    }
    return match;
  }

  return { push, finish };
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

function combineSurrogates(high: number, low: number): number {
  return 0x10000 + (high - 0xd800) * 0x400 + low - 0xdc00;
}
