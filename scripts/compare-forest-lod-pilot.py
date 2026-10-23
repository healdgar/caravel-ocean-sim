#!/usr/bin/env python3
# Copyright (c) 2026 Six Cailloux, LLC. MIT.
"""Compare saved pilot frames. A finite pixel check is not universal LOD proof."""
import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image


def covered_within(mask, radius):
    """Exact discrete Euclidean support expansion, no image resampling."""
    border = math.ceil(radius)
    padded = np.pad(mask, border)
    result = np.zeros_like(mask)
    h, w = mask.shape
    for y in range(-border, border + 1):
        for x in range(-border, border + 1):
            if x*x + y*y <= radius*radius:
                result |= padded[border+y:border+y+h, border+x:border+x+w]
    return result


def image(path):
    return np.asarray(Image.open(path).convert('RGB'), dtype=np.float32) / 255


def compare(folder, case, radius, coverage_tolerance):
    name = case['name']
    ref = image(folder / (name + '-reference-mask.png')).mean(axis=2)
    candidate = image(folder / (name + '-candidate-mask.png')).mean(axis=2)
    if ref.shape != candidate.shape or ref.shape != (case['height'], case['width']):
        raise ValueError('Screenshot/framebuffer dimensions differ: ' + name)
    a, b = ref > .5, candidate > .5
    if not a.any() or not b.any():
        raise ValueError('Empty reference/candidate support: ' + name)
    missing = a & ~covered_within(b, radius)
    excess = b & ~covered_within(a, radius)
    ratio = float(candidate.sum() / ref.sum())
    passed = not missing.any() and not excess.any() and abs(ratio - 1) <= coverage_tolerance
    ref_lit = image(folder / (name + '-reference.png'))
    candidate_lit = image(folder / (name + '-candidate.png'))
    if ref_lit.shape != candidate_lit.shape or ref_lit.shape[:2] != ref.shape:
        raise ValueError('Lit/mask dimensions differ: ' + name)
    union = a | b
    return {
        'name': name,
        'width': case['width'], 'height': case['height'],
        'fractionalCoverageRatio': ratio,
        'binarySupportIoU': float((a & b).sum() / union.sum()),
        'missingSupportPixelsBeyondRadius': int(missing.sum()),
        'excessSupportPixelsBeyondRadius': int(excess.sum()),
        'displayRGBMeanAbsoluteErrorOnUnion': float(np.abs(ref_lit - candidate_lit)[union].mean()),
        'finiteSupportAndCoverageGatePassed': bool(passed),
        'gpuMsMedian': case.get('gpuMsMedian'), 'gpuMsP95': case.get('gpuMsP95'),
        'submittedTriangles': case.get('totalCandidateTriangles'),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--radius', type=float, default=3)
    parser.add_argument('--coverage-tolerance', type=float, default=.05)
    parser.add_argument('--strict', action='store_true')
    args = parser.parse_args()
    if not 0 <= args.radius <= 8 or not 0 <= args.coverage_tolerance <= .25:
        parser.error('Unsafe pixel/coverage tolerance')
    receipt = json.loads((args.folder / 'receipt.json').read_text())
    report = {
        'format': 'waterworld.forest-pilot-image-comparison', 'version': 1,
        'qualified': False,
        'method': 'MSAA white-mask fractional coverage; binary support at >0.5; discrete Euclidean support distance. Lit error is in displayed RGB, not radiometry.',
        'limitations': 'Only saved finite views. Does not certify motion, disocclusion, inside views, weather, shadows, Retina, iPhone or the game. GPU timings are isolated pilot intervals.',
        'maximumSupportDisplacementPixels': args.radius,
        'fractionalCoverageTolerance': args.coverage_tolerance,
        'cases': [compare(args.folder, c, args.radius, args.coverage_tolerance) for c in receipt['results']],
    }
    report['allFiniteImageGatesPassed'] = all(c['finiteSupportAndCoverageGatePassed'] for c in report['cases'])
    (args.folder / 'image-comparison.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    if args.strict and not report['allFiniteImageGatesPassed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
