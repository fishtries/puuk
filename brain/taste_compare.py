"""Offline comparison of an exported taste snapshot and frozen audio vectors.

Usage: python brain/taste_compare.py snapshot.json --at 2026-11-15T12:00:00+00:00
Input: {events:[...], likes:[id], dislikes:[id], vectors:{id:[400 floats]}}.
No application imports, migrations, database/network access or writes.
This measures geometry/weight changes, not recommendation quality.
"""
import argparse
import json
import numpy as np
from services.taste_profile import track_weights, centroid, taste_centers, instant


def compare(data, now):
    snapshot = {**data, 'likes':set(data['likes']), 'dislikes':set(data['dislikes'])}
    vectors = data['vectors']
    weights = track_weights(snapshot, now=now)
    # A frozen current-state baseline, not a historical replay of unknown likes.
    baseline_weights = {str(e['track_id']):1. for e in snapshot['events']
                        if instant(e['ts']) <= now and instant(e['received_at']) <= now
                        and e.get('provenance') not in {'import','qa'}
                        and e['event_type'] in {'start','finish','like'}}
    baseline_weights.update({k:2. for k in snapshot['likes']})
    baseline = centroid(vectors,baseline_weights)
    current = centroid(vectors,weights)
    centers = taste_centers(vectors,weights)
    return {'weights':weights, 'cosine_to_baseline':float(np.dot(baseline,current))
            if baseline is not None and current is not None else None,
            'centers':centers, 'missing_vector_ids':sorted(set(weights)-set(vectors)),
            'limitations':['Current likes/dislikes are not a historical snapshot.',
                          'Baseline is unique positive-track centroid, not complete old serving policy.',
                          'No exposure/outcome or recommendation quality metric is computed.',
                          'Multiple centers are diagnostic and do not change serving.']}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot')
    parser.add_argument('--at', required=True)
    args=parser.parse_args()
    with open(args.snapshot) as handle:
        data=json.load(handle)
    print(json.dumps(compare(data,instant(args.at)),ensure_ascii=False,allow_nan=False))


if __name__=='__main__':main()
