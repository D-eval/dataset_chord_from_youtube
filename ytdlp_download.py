import subprocess
import json
import random
import os
import csv
from fastapi import FastAPI

seg_duration = 0.5
source_file = "./source.csv"
save_dir = "./data"

os.makedirs(os.path.join(save_dir, "music"), exist_ok=True)
os.makedirs(os.path.join(save_dir, "json"), exist_ok=True)
os.makedirs(os.path.join(save_dir, "temp"), exist_ok=True)


sources = []
with open(source_file, "r") as f:
    reader = csv.reader(f)
    for row in reader:
        sources.append(row)

source_head = sources.pop(0)

metas = []
meta_file = os.path.join(save_dir, "meta.csv")
with open(meta_file, "r") as f:
    reader = csv.reader(f)
    for row in reader:
        metas.append(row)
    
meta_head = metas.pop(0)


data_idx = int(metas[-1][0]) + 1 # 先从 save_dir/meta.csv 看看一共有多少条，然后从下一条开始

# 迭代器，如果碰到
def iter_source(sources):
    for idx, (url, title, duration, keyword) in enumerate(sources):
        if duration is None:
            # 跳过当前数据
            return iter_source(sources)
        start_t = random.random() * (duration-seg_duration)
        end_t = start_t + seg_duration

        temp_file = os.path.join(save_dir,"temp",str(idx))
        subprocess.run([
            "yt-dlp",
            url,
            "--download-sections", f"*{start_t}-{end_t}",
            "-x",
            "--audio-format", "mp3",
            "-o", temp_file # 临时保存位置
        ])

        if ...: # 等待前端按按钮，如果按下「下一个」，则保存
            mp3_file = os.path.join(save_dir, "music", str(data_idx+1)+".mp3")
            json_file = os.path.join(save_dir, "json", str(data_idx+1)+".json")
            # 获得前端post过来的json
            # 复制 temp_file 为 mp3_file
        else: # 如果按下「跳过」，什么都不做
            pass
        # 从 temp 删除 
        os.remove(temp_file + ".mp3")
