"""Match public Steam DLC listings to editable, user-owned DLC rows."""

from .title_matching import compare_titles, normalize_title


MATCH_THRESHOLD = 0.94
AMBIGUITY_GAP = 0.03
STATE_RANK = {"not_owned": 0, "not_started": 1, "stopped": 2, "playing": 3, "finished": 4}


def title_score(manual_name: str | None, steam_name: str | None, parent_name: str | None = None) -> float:
    """Accept close spellings and omitted parent prefixes, but keep numbered packs distinct."""
    manual = normalize_title(manual_name)
    steam = normalize_title(steam_name)
    if not manual or not steam:
        return 0.0
    if manual == steam:
        return 1.0
    if min(len(manual), len(steam)) < 10:
        return 0.0
    parent = normalize_title(parent_name)
    pairs = [(manual, steam)]
    if parent:
        trimmed_manual = manual.removeprefix(parent + " ") if manual.startswith(parent + " ") else manual
        trimmed_steam = steam.removeprefix(parent + " ") if steam.startswith(parent + " ") else steam
        pairs.append((trimmed_manual, trimmed_steam))
    shorter, longer = sorted((manual, steam), key=len)
    short_tokens, long_tokens = shorter.split(), longer.split()
    if len(short_tokens) >= 3 and len(long_tokens) > len(short_tokens):
        prefix = long_tokens[:-len(short_tokens)]
        parent_overlap = len(set(prefix) & set(parent.split())) if parent else 0
        if parent_overlap >= 2:
            pairs.append((shorter, " ".join(long_tokens[-len(short_tokens):])))
    return max((match.score for left, right in pairs
                if (match := compare_titles(left, right)).compatible and match.automatic), default=0.0)


def manual_matches(rows: list[dict], catalog: list[dict], parent_name: str) -> dict[int, dict]:
    """Mutual best matches, computed once per catalog to avoid duplicate links."""
    choices: dict[int, list[tuple[float, dict]]] = {}
    for row in rows:
        if not isinstance(row, dict) or row.get("steam_appid"):
            continue
        scores = sorted((
            (title_score(row.get("name"), item["name"], parent_name), item["appid"])
            for item in catalog
        ), reverse=True)
        if not scores or scores[0][0] < MATCH_THRESHOLD:
            continue
        if len(scores) > 1 and scores[1][0] > scores[0][0] - AMBIGUITY_GAP:
            continue
        choices.setdefault(scores[0][1], []).append((scores[0][0], row))
    matches = {}
    for appid, candidates in choices.items():
        candidates.sort(key=lambda pair: pair[0], reverse=True)
        if len(candidates) == 1 or candidates[1][0] <= candidates[0][0] - AMBIGUITY_GAP:
            matches[appid] = candidates[0][1]
    return matches


def matching_manual_row(rows: list[dict], catalog: list[dict], item: dict, parent_name: str) -> dict | None:
    return manual_matches(rows, catalog, parent_name).get(item["appid"])


def merge_catalog(rows: list[dict], catalog: list[dict], parent_appid: int,
                  parent_name: str, seen: set[int]) -> tuple[list[dict], int, set[int]]:
    """Preserve manual rows and progress while attaching stable Steam identities."""
    rows = [row.copy() if isinstance(row, dict) else row for row in rows]
    seen = set(seen)
    added = 0
    matches = manual_matches(rows, catalog, parent_name)
    for item in catalog:
        dlc_id = item["appid"]
        linked_rows = [row for row in rows if isinstance(row, dict) and row.get("steam_appid") == dlc_id]
        linked = linked_rows[0] if linked_rows else None
        for duplicate in linked_rows[1:]:
            if STATE_RANK.get(duplicate.get("state"), 0) > STATE_RANK.get(linked.get("state"), 0):
                linked["state"] = duplicate["state"]
            for key in ("standalone_game_id", "platform", "playtime_hours"):
                if not linked.get(key) and duplicate.get(key):
                    linked[key] = duplicate[key]
            rows.pop(next(index for index, row in enumerate(rows) if row is duplicate))
        manual = matches.get(dlc_id)
        if linked is not None and manual is not None:
            if STATE_RANK.get(manual.get("state"), 0) > STATE_RANK.get(linked.get("state"), 0):
                linked["state"] = manual["state"]
            for key in ("standalone_game_id", "platform", "playtime_hours"):
                if not linked.get(key) and manual.get(key):
                    linked[key] = manual[key]
            rows.remove(manual)
        row = linked or manual
        if row is None and dlc_id in seen:
            continue  # The user previously removed this catalog item.
        if row is None:
            if len(rows) >= 500:
                continue
            row = {"name": item["name"], "state": "not_owned"}
            rows.append(row)
            added += 1
        row["steam_appid"] = dlc_id
        row["steam_parent_appid"] = parent_appid
        if row.get("source") != "Steam":
            row["source"] = "Steam catalog"
        if not row.get("store_url"):
            row["store_url"] = f"https://store.steampowered.com/app/{dlc_id}/"
        if item.get("image_url") and not row.get("image_url"):
            row["image_url"] = item["image_url"]
        seen.add(dlc_id)
    return rows, added, seen
