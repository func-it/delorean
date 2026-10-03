"""The bounded map behind the identification cache."""

from delorean.lru import Lru


def test_forgets_the_least_recently_used() -> None:
    lru: Lru[str, int] = Lru(2)
    lru.put("a", 1)
    lru.put("b", 2)
    assert lru.get("a") == 1  # a is now the most recent
    lru.put("c", 3)
    assert (lru.get("a"), lru.get("b"), lru.get("c")) == (1, None, 3)
    assert len(lru) == 2


def test_a_size_of_zero_keeps_nothing() -> None:
    lru: Lru[str, int] = Lru(0)
    lru.put("a", 1)
    assert lru.get("a") is None
    assert len(lru) == 0
