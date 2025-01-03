"""
POST http://162.105.151.213:2000/api/problem/getProblem

discussionCount: true
displayId: 1002
judgeInfo: true
judgeInfoToBePreprocessed: true
lastSubmissionAndLastAcceptedSubmission: true
localizedContentsOfLocale: "zh_CN"
permissionOfCurrentUser: true
samples: true
statistics: true
tagsOfLocale:  "zh_CN"
"""

import json
import requests

url = "http://162.105.151.213:2000/api/problem/getProblem"

headers = {
    "Content-Type": "application/json"
}

data = {
    "displayId": 1002,
    "discussionCount": True,
    "judgeInfo": True,
    "judgeInfoToBePreprocessed": True,
    "lastSubmissionAndLastAcceptedSubmission": True,
    "localizedContentsOfLocale": "zh_CN",
    "permissionOfCurrentUser": True,
    "samples": True,
    "statistics": True,
    "tagsOfLocale": "zh_CN"
}

try:
    response = requests.post(url, headers=headers, data=json.dumps(data), timeout=10)
    print(response.json())
except requests.exceptions.Timeout:
    print("请求超时")
except requests.exceptions.RequestException as e:
    print(f"请求错误: {e}")
