//! STFT / iSTFT matching the UVR MDX-Net front end (periodic Hann, centred reflect padding,
//! frequency bins truncated to `dim_f`, channels laid out `[L.re, L.im, R.re, R.im]`).

use realfft::{num_complex::Complex32, ComplexToReal, RealFftPlanner, RealToComplex};
use std::sync::Arc;

pub struct Stft {
    pub n_fft: usize,
    pub hop: usize,
    pub dim_f: usize,
    win: Vec<f32>,
    r2c: Arc<dyn RealToComplex<f32>>,
    c2r: Arc<dyn ComplexToReal<f32>>,
}

impl Stft {
    pub fn new(n_fft: usize, hop: usize, dim_f: usize) -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let win = (0..n_fft)
            .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / n_fft as f32).cos()))
            .collect();
        Stft { n_fft, hop, dim_f, win, r2c: planner.plan_fft_forward(n_fft), c2r: planner.plan_fft_inverse(n_fft) }
    }

    /// Forward transform of a stereo chunk (`len == hop * (dim_t - 1)`) into `dst`
    /// (`len == 4 * dim_f * dim_t`).
    pub fn forward(&self, ch: [&[f32]; 2], dim_t: usize, dst: &mut [f32]) {
        let (n, h, f, t) = (self.n_fft, self.n_fft / 2, self.dim_f, dim_t);
        let len = ch[0].len();
        let mut padded = vec![0.0f32; len + n];
        let mut frame = self.r2c.make_input_vec();
        let mut spec = self.r2c.make_output_vec();
        for c in 0..2 {
            let x = ch[c];
            padded[h..h + len].copy_from_slice(x);
            for i in 0..h {
                padded[h - 1 - i] = x[(i + 1).min(len - 1)];
                padded[h + len + i] = x[len.saturating_sub(2 + i)];
            }
            let (re_off, im_off) = ((2 * c) * f * t, (2 * c + 1) * f * t);
            for k in 0..t {
                let s = k * self.hop;
                for i in 0..n {
                    frame[i] = padded[s + i] * self.win[i];
                }
                self.r2c.process(&mut frame, &mut spec).expect("fft");
                for b in 0..f {
                    dst[re_off + b * t + k] = spec[b].re;
                    dst[im_off + b * t + k] = spec[b].im;
                }
            }
        }
    }

    /// Inverse transform of one spectrogram (`4 * dim_f * dim_t`) back to a stereo chunk.
    pub fn inverse(&self, src: &[f32], dim_t: usize, len: usize) -> [Vec<f32>; 2] {
        let (n, h, f, t) = (self.n_fft, self.n_fft / 2, self.dim_f, dim_t);
        let total = (t - 1) * self.hop + n;
        let mut env = vec![1e-8f32; total];
        for k in 0..t {
            for i in 0..n {
                env[k * self.hop + i] += self.win[i] * self.win[i];
            }
        }
        let mut spec = self.c2r.make_input_vec();
        let mut frame = self.c2r.make_output_vec();
        let scale = 1.0 / n as f32;
        [0, 1].map(|c| {
            let mut y = vec![0.0f32; total];
            let (re_off, im_off) = ((2 * c) * f * t, (2 * c + 1) * f * t);
            for k in 0..t {
                spec.iter_mut().for_each(|z| *z = Complex32::new(0.0, 0.0));
                for b in 0..f.min(spec.len()) {
                    spec[b] = Complex32::new(src[re_off + b * t + k], src[im_off + b * t + k]);
                }
                spec[0].im = 0.0;
                let last = spec.len() - 1;
                spec[last].im = 0.0;
                self.c2r.process(&mut spec, &mut frame).expect("ifft");
                let s = k * self.hop;
                for i in 0..n {
                    y[s + i] += frame[i] * scale * self.win[i];
                }
            }
            (0..len).map(|i| y[h + i] / env[h + i]).collect()
        })
    }
}
