import test_db_path
from unittest import mock
import pytest

with mock.patch('qdrant_client.QdrantClient'):
    from services.delivery_service import cdn_expiry, sign_path


def test_same_window_shares_capability_and_next_window_rotates():
    # Independent fixed examples: a five-minute epoch window starts at 900.
    assert cdn_expiry(1000,1800)==2700
    assert cdn_expiry(1199,1800)==2700
    assert cdn_expiry(1200,1800)==3000
    path='/cdn/audio/11111111-1111-4111-8111-111111111111/'+'a'*64
    key='s'*32
    assert sign_path(path,cdn_expiry(1000,1800),key)==sign_path(path,cdn_expiry(1199,1800),key)
    assert sign_path(path,cdn_expiry(1200,1800),key)!=sign_path(path,cdn_expiry(1199,1800),key)


@pytest.mark.parametrize('ttl',[60,61,89,119,120,299,300,359,600,1800])
def test_every_boundary_keeps_permission_within_the_security_budget(ttl):
    previous=0
    for now in range(1_794_830_000,1_794_831_200):
        expires=cdn_expiry(now,ttl)
        assert 60<=expires-now<=ttl
        assert expires>=previous
        previous=expires


def test_shortest_supported_test_ttl_is_not_reduced():
    assert cdn_expiry(1000,60)==1060
    assert cdn_expiry(1001,60)==1061
