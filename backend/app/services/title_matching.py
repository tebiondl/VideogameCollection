"""Structured videogame-title comparison for identity decisions.

This deliberately does not replace ordinary search. It is for places where a
fuzzy match may merge records, attach a provider identity, or flag a duplicate.
"""

from dataclasses import dataclass
import re
import unicodedata


NUMBER_WORDS = {
    "one": 1, "first": 1,
    "two": 2, "second": 2,
    "three": 3, "third": 3,
    "four": 4, "fourth": 4,
    "five": 5, "fifth": 5,
    "six": 6, "sixth": 6,
    "seven": 7, "seventh": 7,
    "eight": 8, "eighth": 8,
    "nine": 9, "ninth": 9,
    "ten": 10, "tenth": 10,
    "eleven": 11, "eleventh": 11,
    "twelve": 12, "twelfth": 12,
    "thirteen": 13, "thirteenth": 13,
    "fourteen": 14, "fourteenth": 14,
    "fifteen": 15, "fifteenth": 15,
    "sixteen": 16, "sixteenth": 16,
    "seventeen": 17, "seventeenth": 17,
    "eighteen": 18, "eighteenth": 18,
    "nineteen": 19, "nineteenth": 19,
    "twenty": 20, "twentieth": 20,
}
NUMBER_MARKERS = {
    "part", "pt", "episode", "ep", "chapter", "season", "volume", "vol", "book",
}
EDITION_TOKENS = {
    "anniversary", "classic", "complete", "definitive", "deluxe", "edition", "enhanced",
    "goty", "hd", "remaster", "remastered", "redux", "special", "ultimate", "collection",
}
SEPARATE_RELEASE_TOKENS = {"remake", "demake", "reboot"}
CONTENT_VARIANT_TOKENS = {
    "alpha", "beta", "demo", "network", "playtest", "server", "soundtrack", "test",
}
ALL_VARIANT_TOKENS = EDITION_TOKENS | SEPARATE_RELEASE_TOKENS | CONTENT_VARIANT_TOKENS
REVIEW_STOPWORDS = {"a", "an", "and", "for", "in", "of", "the", "to", "with"}
ROMAN_PATTERN = re.compile(r"^(?=[ivxlcdm]+$)m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$")


def _fold_title(value: str | None) -> str:
    # NFKD expands the trademark glyph to the ASCII letters "TM", which made
    # otherwise identical Steam titles look different (NieR:Automata™). Remove
    # legal marks before folding, including the textual suffix some APIs emit.
    raw = re.sub(r"\(\s*(?:tm|r|c)\s*\)\s*$", " ", value or "", flags=re.IGNORECASE)
    raw = raw.translate(str.maketrans({"™": " ", "®": " ", "©": " "}))
    folded = unicodedata.normalize("NFKD", raw)
    return "".join(char for char in folded if not unicodedata.combining(char)).casefold()


@dataclass(frozen=True)
class ParsedTitle:
    normalized: str
    base: str
    installments: tuple[str, ...]
    variants: frozenset[str]


@dataclass(frozen=True)
class TitleMatch:
    score: float
    compatible: bool
    automatic: bool
    relation: str
    left: ParsedTitle
    right: ParsedTitle


def normalize_title(value: str | None) -> str:
    folded = _fold_title(value)
    return " ".join(re.sub(r"[^a-z0-9]+", " ", folded).split())


def _roman_number(token: str) -> int | None:
    if not token or not ROMAN_PATTERN.fullmatch(token) or token == "":
        return None
    values = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}
    total = previous = 0
    for char in reversed(token):
        current = values[char]
        if current < previous:
            total -= current
        else:
            total += current
            previous = current
    return total if 0 < total <= 50 else None


def _number_token(token: str, *, allow_words: bool, allow_roman: bool) -> str | None:
    decimal = re.fullmatch(r"(\d+)decimal(\d+)", token)
    if decimal:
        return f"{int(decimal.group(1))}.{decimal.group(2).rstrip('0') or '0'}"
    if token.isdigit():
        return str(int(token))
    if allow_words and token in NUMBER_WORDS:
        return str(NUMBER_WORDS[token])
    if allow_roman:
        value = _roman_number(token)
        if value is not None:
            return str(value)
    return None


def parse_title(value: str | None) -> ParsedTitle:
    raw = _fold_title(value)
    # A parenthesized release year is normally edition metadata, while an
    # unparenthesized year (F1 2024, Football Manager 2024) identifies a title.
    raw = re.sub(r"\((?:19|20)\d{2}\)", " ", raw)
    raw = re.sub(r"(?<=\d)\.(?=\d)", "decimal", raw)
    normalized = " ".join(re.sub(r"[^a-z0-9]+", " ", raw).split())
    tokens = normalized.split()
    variants = frozenset(token for token in tokens if token in ALL_VARIANT_TOKENS)
    ignored = {index for index, token in enumerate(tokens) if token in ALL_VARIANT_TOKENS}
    numbered: list[tuple[int, str]] = []

    for index, token in enumerate(tokens[:-1]):
        if token not in NUMBER_MARKERS:
            continue
        number = _number_token(tokens[index + 1], allow_words=True, allow_roman=True)
        if number is not None:
            numbered.append((index + 1, number))
            ignored.update((index, index + 1))

    significant = [index for index, token in enumerate(tokens) if index not in ignored and token not in NUMBER_MARKERS]
    last_significant = significant[-1] if significant else -1
    already_numbered = {index for index, _ in numbered}
    for index in significant:
        if index in already_numbered:
            continue
        token = tokens[index]
        # Arabic numbers are identity-bearing wherever they appear. Roman and
        # written numbers are restricted to the title suffix to avoid treating
        # the pronoun in "I Am Setsuna" or "One" in "One Piece" as sequels.
        roman_value = _roman_number(token)
        word_value = NUMBER_WORDS.get(token)
        number = _number_token(
            token,
            allow_words=index == last_significant or bool(word_value and word_value >= 2),
            allow_roman=index == last_significant or bool(roman_value and roman_value >= 2),
        )
        if number is not None:
            numbered.append((index, number))
            ignored.add(index)

    numbered.sort()
    base_tokens = [
        token for index, token in enumerate(tokens)
        if index not in ignored and token not in NUMBER_MARKERS
    ]
    return ParsedTitle(
        normalized=normalize_title(value),
        base=" ".join(base_tokens),
        installments=tuple(number for _, number in numbered),
        variants=variants,
    )


def _levenshtein_similarity(left: str, right: str) -> float:
    if left == right:
        return 1.0 if left else 0.0
    if not left or not right:
        return 0.0
    distances = [[0] * (len(right) + 1) for _ in range(len(left) + 1)]
    for left_index in range(len(left) + 1):
        distances[left_index][0] = left_index
    for right_index in range(len(right) + 1):
        distances[0][right_index] = right_index
    for left_index, left_char in enumerate(left, 1):
        for right_index, right_char in enumerate(right, 1):
            distances[left_index][right_index] = min(
                distances[left_index - 1][right_index] + 1,
                distances[left_index][right_index - 1] + 1,
                distances[left_index - 1][right_index - 1] + (left_char != right_char),
            )
            if (
                left_index > 1 and right_index > 1
                and left_char == right[right_index - 2]
                and left[left_index - 2] == right_char
            ):
                distances[left_index][right_index] = min(
                    distances[left_index][right_index],
                    distances[left_index - 2][right_index - 2] + 1,
                )
    return 1 - distances[-1][-1] / max(len(left), len(right))


def _base_similarity(left: str, right: str) -> float:
    score = _levenshtein_similarity(left, right)
    left_tokens, right_tokens = set(left.split()), set(right.split())
    if not left_tokens or not right_tokens:
        return score
    coverage = len(left_tokens & right_tokens) / min(len(left_tokens), len(right_tokens))
    shortest = min(len(left_tokens), len(right_tokens))
    if coverage == 1 and shortest >= 2:
        score = max(score, 0.86)
    elif coverage >= 2 / 3:
        score = max(score, 0.76)
    elif coverage == 1 and shortest == 1:
        score = max(score, 0.74)
    return score


def compare_titles(first: str | None, second: str | None) -> TitleMatch:
    left, right = parse_title(first), parse_title(second)
    if left.normalized and left.normalized == right.normalized:
        relation = "same_installment" if left.installments else "same_title_family"
        return TitleMatch(1.0, True, True, relation, left, right)
    base_score = _base_similarity(left.base, right.base)

    if left.installments and right.installments and left.installments != right.installments:
        return TitleMatch(0.0, False, False, "different_installment", left, right)
    if bool(left.installments) != bool(right.installments):
        present = left.installments or right.installments
        if present == ("1",) and base_score >= 0.94:
            relation = "implicit_first_installment"
            score = min(base_score, 0.96)
            automatic = False
        elif present != ("1",) and 0.72 <= base_score < 0.94:
            # A short common name can omit a series numeral entirely ("Skyrim"
            # vs "The Elder Scrolls V: Skyrim"). It may be reviewed, but never
            # selected automatically. Exact-base pairs such as Portal/Portal 2
            # remain a hard installment conflict.
            relation = "ambiguous_numbered_alias"
            score = base_score
            automatic = False
        else:
            return TitleMatch(0.0, False, False, "different_installment", left, right)
    else:
        relation = "same_installment" if left.installments else "same_title_family"
        score = base_score
        automatic = True

    variant_difference = left.variants ^ right.variants
    if variant_difference & (SEPARATE_RELEASE_TOKENS | CONTENT_VARIANT_TOKENS):
        return TitleMatch(0.0, False, False, "different_release", left, right)
    if variant_difference:
        score = max(0.0, score - 0.18)
        automatic = False
        relation = "different_edition"

    return TitleMatch(round(score, 6), True, automatic, relation, left, right)


def is_reviewable_title_match(match: TitleMatch) -> bool:
    """Whether a non-exact identity is strong enough to interrupt a sync.

    ``compatible`` is deliberately broad because it is also useful for search
    ranking. A sync review needs stronger evidence: a close spelling match, a
    known edition of the same base, or a multi-word title contained in the
    other title. This keeps incidental shared words from turning new games into
    hundreds of manual decisions.
    """
    if not match.compatible:
        return False
    if match.score >= 0.90:
        return True
    if match.relation == "different_edition" and match.score >= 0.80:
        return True

    left_tokens = match.left.base.split()
    right_tokens = match.right.base.split()
    left_set, right_set = set(left_tokens), set(right_tokens)
    shared = (left_set & right_set) - REVIEW_STOPWORDS
    contained = left_set <= right_set or right_set <= left_set
    if match.score >= 0.82 and len(shared) >= 2 and sum(map(len, shared)) >= 8 and contained:
        return True

    # Preserve useful short aliases such as "Skyrim" versus
    # "The Elder Scrolls V: Skyrim", without accepting prefix collisions such
    # as Portal/Portal Knights or Borderlands 2/Borderlands: The Pre-Sequel.
    shorter, longer = (left_tokens, right_tokens) if len(left_tokens) <= len(right_tokens) else (right_tokens, left_tokens)
    return bool(
        match.relation == "ambiguous_numbered_alias"
        and len(shorter) == 1
        and len(longer) >= 4
        and shorter[0] == longer[-1]
    )
