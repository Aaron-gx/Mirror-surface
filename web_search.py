"""
MiMo 联网搜索工具
使用方法:
    python web_search.py "你的搜索问题"
    python web_search.py --api-key YOUR_KEY "你的搜索问题"

环境变量:
    MIMO_API_KEY - MiMo API 密钥
"""

import argparse
import json
import os
import sys

try:
    from openai import OpenAI
except ImportError:
    print("需要安装 openai 库: pip install openai")
    sys.exit(1)


def search(query: str, api_key: str, max_keywords: int = 3, force_search: bool = True) -> dict:
    client = OpenAI(
        api_key=api_key,
        base_url="https://api.xiaomimimo.com/v1",
    )

    completion = client.chat.completions.create(
        model="mimo-v2.5-pro",
        messages=[
            {
                "role": "user",
                "content": query,
            }
        ],
        tools=[
            {
                "type": "web_search",
                "max_keyword": max_keywords,
                "force_search": force_search,
                "limit": 5,
            }
        ],
        tool_choice="auto",
        max_completion_tokens=2048,
        temperature=1.0,
        top_p=0.95,
        stream=False,
    )

    return completion


def format_result(completion) -> str:
    choice = completion.choices[0]
    msg = choice.message

    lines = []

    # 搜索结果来源
    if msg.annotations:
        lines.append("=== 搜索来源 ===")
        for i, ann in enumerate(msg.annotations, 1):
            ann_dict = ann if isinstance(ann, dict) else ann.model_dump() if hasattr(ann, 'model_dump') else {}
            ann_type = ann_dict.get("type", "")
            if ann_type == "url_citation":
                title = ann_dict.get("title", "无标题")
                url = ann_dict.get("url", "")
                site = ann_dict.get("site_name", "")
                lines.append(f"  [{i}] {title}")
                lines.append(f"      {url} ({site})")
        lines.append("")

    # 回答内容
    lines.append("=== 搜索结果 ===")
    lines.append(msg.content)

    # Token 使用情况
    usage = completion.usage
    if usage:
        ws = usage.web_search_usage if hasattr(usage, 'web_search_usage') else None
        if ws:
            ws_dict = ws if isinstance(ws, dict) else ws.model_dump() if hasattr(ws, 'model_dump') else {}
            lines.append(f"\n[搜索工具调用 {ws_dict.get('tool_usage', '?')} 次, 使用页面 {ws_dict.get('page_usage', '?')} 个]")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="MiMo 联网搜索工具")
    parser.add_argument("query", help="搜索问题")
    parser.add_argument("--api-key", default=None, help="MiMo API Key (或设置 MIMO_API_KEY 环境变量)")
    parser.add_argument("--max-keywords", type=int, default=3, help="最大搜索关键词数 (默认 3)")
    parser.add_argument("--force", action="store_true", default=True, help="强制搜索 (默认开启)")
    parser.add_argument("--no-force", dest="force", action="store_false", help="由模型判断是否搜索")
    parser.add_argument("--json", action="store_true", help="输出原始 JSON")

    args = parser.parse_args()

    api_key = args.api_key or os.environ.get("MIMO_API_KEY")
    if not api_key:
        print("错误: 请通过 --api-key 或 MIMO_API_KEY 环境变量提供 API Key")
        sys.exit(1)

    completion = search(args.query, api_key, args.max_keywords, args.force)

    if args.json:
        print(completion.model_dump_json(indent=2))
    else:
        print(format_result(completion))


if __name__ == "__main__":
    main()
