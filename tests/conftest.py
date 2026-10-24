"""what the tests share: the server modules on the path, the real archive day in tests/data (the user's own
2026-10-12 of ES) as an Archive and a Timeline"""
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "server"))
sys.path.insert(0, HERE)

import archive as A  # noqa: E402
import timeline as T  # noqa: E402

DATA = os.path.join(HERE, "data")
DAY = "2026-10-12"


@pytest.fixture(scope="session")
def arch():
    return A.Archive(DATA)


@pytest.fixture(scope="session")
def tl(arch):
    return T.Timeline(arch)
