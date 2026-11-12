# Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
"""A plain BC7 encoder for scripts/prepare-forest-surfaces.py --builtin, for a machine without bc7enc.

Each 4x4 block is tried two ways and keeps the closer one:
  mode 6  one line through all four channels, sixteen steps along it
  mode 5  one line through red, green and blue with four steps, and alpha on four steps of its own
Once each pixel has its step, the line's ends are fitted again to the pixels that took each step, and kept
where that lands closer. The fit holds a block's mean, which is what a leaf's coverage is at the coarse levels.
bc7enc searches all eight modes and their partitions and comes closer still, most of all on blocks
that hold two unrelated colours. Rebake with it when it is to hand.
"""
import numpy as np

WEIGHTS_4BIT = np.array([0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64], dtype=np.int64)
WEIGHTS_2BIT = np.array([0, 21, 43, 64], dtype=np.int64)


def _line(pixels):
    """The two ends of the best line through each block's sixteen values."""
    mean = pixels.mean(axis=1, keepdims=True)
    centred = pixels - mean
    covariance = np.einsum('npc,npd->ncd', centred, centred)
    axis = pixels.max(axis=1) - pixels.min(axis=1) + 1e-6
    for _ in range(12):
        axis = np.einsum('ncd,nd->nc', covariance, axis)
        axis /= np.maximum(np.linalg.norm(axis, axis=1, keepdims=True), 1e-12)
    along = np.einsum('npc,nc->np', centred, axis)
    low = mean[:, 0] + along.min(axis=1, keepdims=True) * axis
    high = mean[:, 0] + along.max(axis=1, keepdims=True) * axis
    return np.clip(low, 0, 255), np.clip(high, 0, 255)


def _choose(pixels, first, second, weights):
    """Each pixel's nearest step between two whole-number ends, as the decoder interpolates them."""
    w = weights[None, :, None]
    palette = ((64 - w) * first[:, None, :] + w * second[:, None, :] + 32) >> 6
    distance = ((pixels[:, :, None, :] - palette[:, None, :, :]) ** 2).sum(axis=3)
    return distance.argmin(axis=2), distance.min(axis=2).sum(axis=1)


def _refit(pixels, index, weights):
    """The ends that best fit each block's pixels, given the step each pixel took: least squares, a channel at a time."""
    w = weights[index] / 64.0
    a, b, c = ((1 - w) ** 2).sum(axis=1), (w * (1 - w)).sum(axis=1), (w ** 2).sum(axis=1)
    first_sum, second_sum = np.einsum('np,npc->nc', 1 - w, pixels), np.einsum('np,npc->nc', w, pixels)
    det = a * c - b * b
    # A block whose pixels all took one step has no line to fit.
    fitted = det > 1e-6
    safe = np.where(fitted, det, 1.0)[:, None]
    first = (c[:, None] * first_sum - b[:, None] * second_sum) / safe
    second = (a[:, None] * second_sum - b[:, None] * first_sum) / safe
    return np.clip(first, 0, 255), np.clip(second, 0, 255), fitted


def _anchor(index, first, second, top):
    """The first pixel's index is stored one bit short, so its high bit must be clear: swap ends if not."""
    swap = index[:, 0] > top // 2
    index = np.where(swap[:, None], top - index, index)
    return index, np.where(swap[:, None], second, first), np.where(swap[:, None], first, second)


class _Bits:
    def __init__(self, count):
        self.low = np.zeros(count, dtype=np.uint64)
        self.high = np.zeros(count, dtype=np.uint64)
        self.at = 0

    def put(self, value, bits):
        value = np.asarray(value).astype(np.uint64)
        at = self.at
        if at < 64:
            self.low |= value << np.uint64(at)
            if at + bits > 64:
                self.high |= value >> np.uint64(64 - at)
        else:
            self.high |= value << np.uint64(at - 64)
        self.at += bits

    def blocks(self):
        assert self.at == 128
        return np.stack((self.low, self.high), axis=1).astype('<u8')


def _mode6(pixels):
    def stored(end):
        # Seven bits a channel and one low bit shared by all four: keep whichever shared bit lands closer.
        tries = [np.clip(np.round((end - p) / 2), 0, 127).astype(np.int64) * 2 + p for p in (0, 1)]
        errors = [((t - end) ** 2).sum(axis=1) for t in tries]
        return np.where((errors[1] < errors[0])[:, None], tries[1], tries[0])

    ends = [stored(end) for end in _line(pixels)]
    index, error = _choose(pixels, ends[0], ends[1], WEIGHTS_4BIT)
    low, high, fitted = _refit(pixels, index, WEIGHTS_4BIT)
    again = [stored(low), stored(high)]
    again_index, again_error = _choose(pixels, again[0], again[1], WEIGHTS_4BIT)
    better = fitted & (again_error < error)
    ends = [np.where(better[:, None], again[k], ends[k]) for k in range(2)]
    index, error = np.where(better[:, None], again_index, index), np.where(better, again_error, error)
    index, first, second = _anchor(index, ends[0], ends[1], 15)
    bits = _Bits(len(pixels))
    bits.put(np.full(len(pixels), 1 << 6), 7)
    for channel in range(4):
        bits.put(first[:, channel] >> 1, 7)
        bits.put(second[:, channel] >> 1, 7)
    bits.put(first[:, 0] & 1, 1)
    bits.put(second[:, 0] & 1, 1)
    bits.put(index[:, 0], 3)
    for pixel in range(1, 16):
        bits.put(index[:, pixel], 4)
    return bits.blocks(), error


def _mode5(pixels):
    widen = lambda end: (lambda q: (q << 1) | (q >> 6))(np.clip(np.round(end * 127 / 255), 0, 127).astype(np.int64))
    whole = lambda end: np.round(end).astype(np.int64)

    def fitted_line(values, low, high, store):
        """A line's stored ends and each pixel's step along it, fitted once more to the steps the pixels took."""
        ends = [store(low), store(high)]
        index, error = _choose(values, ends[0], ends[1], WEIGHTS_2BIT)
        again_low, again_high, fitted = _refit(values, index, WEIGHTS_2BIT)
        again = [store(again_low), store(again_high)]
        again_index, again_error = _choose(values, again[0], again[1], WEIGHTS_2BIT)
        better = fitted & (again_error < error)
        ends = [np.where(better[:, None], again[k], ends[k]) for k in range(2)]
        return np.where(better[:, None], again_index, index), np.where(better, again_error, error), ends

    colour_index, colour_error, colour_ends = fitted_line(pixels[:, :, :3], *_line(pixels[:, :, :3]), widen)
    colour_index, first, second = _anchor(colour_index, colour_ends[0], colour_ends[1], 3)
    alpha = pixels[:, :, 3:4]
    alpha_index, alpha_error, alpha_ends = fitted_line(alpha, alpha.min(axis=1), alpha.max(axis=1), whole)
    alpha_index, alpha_first, alpha_second = _anchor(alpha_index, alpha_ends[0], alpha_ends[1], 3)
    bits = _Bits(len(pixels))
    bits.put(np.full(len(pixels), 1 << 5), 6)
    bits.put(np.zeros(len(pixels)), 2)
    for channel in range(3):
        bits.put(first[:, channel] >> 1, 7)
        bits.put(second[:, channel] >> 1, 7)
    bits.put(alpha_first[:, 0], 8)
    bits.put(alpha_second[:, 0], 8)
    for index in (colour_index, alpha_index):
        bits.put(index[:, 0], 1)
        for pixel in range(1, 16):
            bits.put(index[:, pixel], 2)
    return bits.blocks(), colour_error + alpha_error


def encode_bc7_blocks(image):
    """`image` is height x width x 4 bytes with both sides a multiple of four. Returns the raw blocks."""
    height, width = image.shape[:2]
    assert height % 4 == 0 and width % 4 == 0 and image.shape[2] == 4
    pixels = image.reshape(height // 4, 4, width // 4, 4, 4).transpose(0, 2, 1, 3, 4).reshape(-1, 16, 4).astype(np.float64)
    out = np.empty((len(pixels), 2), dtype='<u8')
    for start in range(0, len(pixels), 8192):
        part = pixels[start:start + 8192]
        six, six_error = _mode6(part)
        five, five_error = _mode5(part)
        out[start:start + 8192] = np.where((five_error < six_error)[:, None], five, six)
    return out.tobytes()
