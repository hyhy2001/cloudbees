"""Tests for SQLite cache manager."""

import time
import pytest
from pathlib import Path
from cb.db.connection import init_db
from cb.cache.manager import get_cached, set_cache, invalidate, purge_expired, clear_all


@pytest.fixture
def db(tmp_path):
    db_path = tmp_path / "test.db"
    init_db(db_path)
    return db_path


def test_cache_miss(db):
    assert get_cached("nonexistent", db) is None


def test_cache_set_and_hit(db):
    data = {"jobs": [1, 2, 3]}
    set_cache("jobs.list", data, ttl=60, db_path=db)
    result = get_cached("jobs.list", db)
    assert result == data


def test_cache_expire(db):
    set_cache("tmp.key", {"x": 1}, ttl=1, db_path=db)
    time.sleep(1.1)
    assert get_cached("tmp.key", db) is None


def test_invalidate(db):
    set_cache("jobs.list", [1, 2], ttl=60, db_path=db)
    invalidate("jobs.list", db)
    assert get_cached("jobs.list", db) is None


def test_purge_expired(db):
    set_cache("a", {}, ttl=1, db_path=db)
    set_cache("b", {}, ttl=60, db_path=db)
    time.sleep(1.1)
    n = purge_expired(db)
    assert n == 1
    assert get_cached("b", db) is not None


def test_clear_all(db):
    set_cache("x", {}, ttl=60, db_path=db)
    set_cache("y", {}, ttl=60, db_path=db)
    clear_all(db)
    assert get_cached("x", db) is None
    assert get_cached("y", db) is None
