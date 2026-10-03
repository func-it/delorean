"""A bounded map that forgets what was used least recently."""

from collections import OrderedDict


class Lru[K, V]:
    """At most `size` entries; past it, the least recently used one goes. A
    size of 0 keeps nothing. Not thread-safe: one event loop uses it."""

    def __init__(self, size: int) -> None:
        self.size = size
        self._entries: OrderedDict[K, V] = OrderedDict()

    def __len__(self) -> int:
        return len(self._entries)

    def get(self, key: K) -> V | None:
        if key not in self._entries:
            return None
        self._entries.move_to_end(key)
        return self._entries[key]

    def put(self, key: K, value: V) -> None:
        if self.size <= 0:
            return
        self._entries[key] = value
        self._entries.move_to_end(key)
        while len(self._entries) > self.size:
            self._entries.popitem(last=False)
