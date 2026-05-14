import csv
import os
import json
import librosa
import numpy as np
import torch
from torch.utils.data import Dataset, DataLoader

current_file = os.path.abspath(__file__)
current_dir = os.path.dirname(current_file)

data_dir = os.path.join(current_dir, "data")
duration = 0.5
sr = 44100


PITCHNAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
CHORDNAMES = ["maj", "min", "dom", "dim", "aug", "N"]
duration_len = int(duration * sr)

class StackDataset(Dataset):
    def __init__(self, sr):
        super().__init__()
        self.sr = sr
        
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
        midis = [m + shift for m in midis]
        
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
            }
        else:
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
            for midi in midis:
                p = midi % 12
                pitch_vec[p] = 1
                if p not in pitch_cls:pitch_cls.append(p)


            target = {
                "symbol":symbol,
                
                "pitch_cls": pitch_cls, # List
                "pitch_vec": pitch_vec, # (12,)
                "exist": torch.tensor([exist]).float(), # (1,)
                
                "root_idx": torch.tensor([root_idx]).long(), # (1,)
                "bass_idx": torch.tensor([bass_idx]).long(), # (1,)
                "chord_idx": torch.tensor([chord_idx]).long(), # (1,)
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