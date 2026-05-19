import csv
import os
import json
import librosa
import numpy as np
import torch
from torch.utils.data import Dataset, DataLoader

import random

def sim_noise_label(
    midis,
    p_fifth=0.10,
    p_octave=0.15,
    p_add=0.10,
    p_remove=0.10,
):
    """
    模拟 AMT noisy label
    
    错误类型:
    1. 五度泛音混淆
    2. 八度混淆
    3. 多标音符
    4. 漏标音符
    """

    midis = list(midis)

    if len(midis) == 0:
        return midis

    # ===== 五度泛音 =====
    if random.random() < p_fifth:
        m = random.choice(midis)

        # 更像泛音误判：增加，而不是替换
        shift = random.choice([7, -7])
        m2 = m + shift

        if 24 <= m2 <= 107:
            midis.append(m2)

    # ===== 八度混淆 =====
    if random.random() < p_octave:
        idx = random.randrange(len(midis))

        shift = random.choice([12, -12])
        m2 = midis[idx] + shift

        if 24 <= m2 <= 107:
            midis[idx] = m2

    # ===== 漏标 =====
    if random.random() < p_remove:
        if len(midis) > 1:
            idx = random.randrange(len(midis))
            midis.pop(idx)

    # ===== 多标 =====
    if random.random() < p_add:
        m = random.choice(midis)

        candidate = []
        for shift in [-12, -7, 7, 12]:
            m2 = m + shift
            if 24 <= m2 <= 107:
                candidate.append(m2)

        if len(candidate) > 0:
            midis.append(random.choice(candidate))

    # 去重排序
    midis = sorted(list(set(midis)))

    return midis


current_file = os.path.abspath(__file__)
current_dir = os.path.dirname(current_file)

data_dir = os.path.join(current_dir, "data")
duration = 0.5
sr = 44100


PITCHNAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
CHORDNAMES = ["maj", "min", "dom", "dim", "aug", "N"]
duration_len = int(duration * sr)

class StackDataset(Dataset):
    def __init__(self, sr, min_midi, max_midi):
        super().__init__()
        self.sr = sr
        self.min_midi = min_midi
        self.max_midi = max_midi
        self.P = max_midi - min_midi + 1
        
        meta_file = os.path.join(data_dir, "meta.csv")
        metas = []
        with open(meta_file, "r") as f:
            reader = csv.reader(f)
            for row in reader:
                metas.append(row)

        head = metas.pop(0)
        all_idx = [m[0] for m in metas]

        # filter
        value_to_remove = []
        for temp_serial in all_idx:
            audio_filename = os.path.join(data_dir, "music", str(temp_serial)+".mp3")
            
            json_filename = os.path.join(data_dir, "json", str(temp_serial)+".json")
            with open(json_filename,"r") as f:
                labels = json.load(f)
            symbol = labels['text']
            if symbol in ["M", "S"]:
                value_to_remove.append(temp_serial)
                continue
            audio, sr = librosa.load(audio_filename, mono=False, sr=sr)
            audio = audio.T
            if audio.shape[0] != duration_len:
                value_to_remove.append(temp_serial)

        for v in value_to_remove:
            all_idx.remove(v)

        self.all_idx = all_idx

        self.samples = []

        for temp_serial in all_idx:
            for shift in range(-7,7):
                self.samples.append(
                    (temp_serial, shift)
                )

        self.apply_label_noise = False

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        
        temp_serial, shift = self.samples[idx]
        
        audio_filename = os.path.join(data_dir, "music", str(temp_serial)+".mp3")
        json_filename = os.path.join(data_dir, "json", str(temp_serial)+".json")

        audio, sr = librosa.load(audio_filename, mono=False, sr=self.sr)
                
        audio_shift = []
        for ch in audio:
            temp = librosa.effects.pitch_shift(
                ch,
                sr=self.sr,
                n_steps=shift
            )
            audio_shift.append(temp)
        audio = np.stack(audio_shift, axis=0)
        
        with open(json_filename,"r") as f:
            labels = json.load(f)

        midis = labels['midi']
        # 过滤掉太低的
        midis_shift = []
        for m in midis:
            m2 = m + shift
            if self.min_midi <= m2 <= self.max_midi:
                midis_shift.append(m2)
        midis = midis_shift
        
        if self.apply_label_noise:
            midis = sim_noise_label(midis)
        
        symbol = labels['text']

        exist = 1
        root_name = None
        quality_name = None
        bass_name = None
        if ":" not in symbol: # N 分支
            exist = 0
            target = {
                "symbol":symbol,
                "exist": torch.tensor([exist]), # (1,)
                "midi": "N",
                "midi_manyhot": torch.zeros(self.P)
            }
        else:
            assert len(midis) > 0
            if "/" not in symbol:
                root_name, quality_name = symbol.split(":")
                bass_name = root_name
            else:
                voicing_name, bass_name = symbol.split("/")
                root_name, quality_name = voicing_name.split(":")
            root_idx = PITCHNAMES.index(root_name)
            bass_idx = PITCHNAMES.index(bass_name)
            chord_idx = CHORDNAMES.index(quality_name)

            root_idx = (root_idx + shift) % 12
            bass_idx = (bass_idx + shift) % 12
            
            root_name = PITCHNAMES[root_idx]
            bass_name = PITCHNAMES[bass_idx]
            if root_name==bass_name:
                symbol = f"{root_name}:{quality_name}"
            else:
                symbol = f"{root_name}:{quality_name}/{bass_name}"
            
            pitch_cls = []
            pitch_vec = torch.zeros((12))
            P = self.P
            N = len(midis)
            midi_vec = torch.zeros((N, P))
            midi_manyhot = torch.zeros((P))
            min_midi = self.min_midi
            
            for n, midi in enumerate(midis):
                p = midi % 12
                pitch_vec[p] = 1
                midi_vec[n, midi - min_midi] = 1
                midi_manyhot[midi-min_midi] = 1
                if p not in pitch_cls:pitch_cls.append(p)

            target = {
                "symbol":symbol,
                
                "midi":midis,
                "midi_vec":midi_vec, # (N,P,)
                "midi_manyhot":midi_manyhot, # (P,)
                
                "pitch_cls": pitch_cls, # List
                "pitch_vec": pitch_vec, # (12,)
                "exist": torch.tensor([exist]).float(), # (1,)
                
                "root_idx": torch.tensor([root_idx]).long(), # (1,)
                "bass_idx": torch.tensor([bass_idx]).long(), # (1,)
                "chord_idx": torch.tensor([chord_idx]).long(), # (1,)
                
                "root_name": root_name,
                "chord_name": quality_name
            }

        audio = torch.tensor(audio.T)
        return audio, target


def collate_fn(batch):
    audios = []
    targets = []

    for audio, target in batch:
        audios.append(audio)
        targets.append(target)

    audios = torch.stack(audios, dim=0)  # (B,T,C)
    return audios, targets

if __name__ == "__main__":
    dataset = StackDataset(sr)
    loader = DataLoader(dataset, 2, shuffle=True, collate_fn=collate_fn, num_workers=0)
    for batch in loader:
        audio, target = batch
        print(audio.shape)
        print(target[0]['symbol'])