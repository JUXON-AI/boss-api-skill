"""Render an already validated online resume snapshot; no network or candidate actions."""
import argparse
import hashlib
import json
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, KeepTogether

LABELS = {
    'school': '院校', 'major': '专业', 'degreeName': '学历',
    'startDateDesc': '开始时间', 'endDateDesc': '结束时间',
    'startYearMonStr': '开始时间', 'endYearMonStr': '结束时间',
    'company': '公司', 'brandName': '公司', 'positionName': '岗位',
    'department': '部门', 'jobName': '岗位', 'name': '项目', 'roleName': '职责',
    'educationDescription': '教育经历说明', 'workDescription': '工作内容',
    'responsibility': '本人职责', 'projectDescription': '项目说明',
    'description': '说明', 'achievement': '成果',
}


def render(snapshot, output, font):
    if snapshot.get('kind') != 'boss_online_resume_summary_snapshot' or snapshot.get('fullTextVerified') is not False:
        raise ValueError('Only explicitly partial online summary snapshots are supported')
    if output.exists() or not output.parent.is_dir():
        raise ValueError('A new file in an existing protected output directory is required')
    if 'ResumeCJK' not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont('ResumeCJK', str(font), subfontIndex=0))
    title = ParagraphStyle('Title', fontName='ResumeCJK', fontSize=18, leading=25, textColor=colors.HexColor('#183d4d'), spaceAfter=10)
    normal = ParagraphStyle('Normal', fontName='ResumeCJK', fontSize=10, leading=16, alignment=TA_LEFT, wordWrap='CJK', spaceAfter=5)
    small = ParagraphStyle('Small', parent=normal, fontSize=8, leading=12, textColor=colors.HexColor('#52616b'))
    heading = ParagraphStyle('Heading', parent=normal, fontSize=12, leading=19, textColor=colors.HexColor('#183d4d'), spaceBefore=10, spaceAfter=5)
    def para(value, style=normal):
        return Paragraph(escape(str(value)).replace('\n', '<br/>'), style)
    c, source = snapshot['candidate'], snapshot['source']
    alias = snapshot.get('verifiedDisplayAlias')
    if alias:
        if alias.get('sourceName') != c['name'] or not isinstance(alias.get('currentName'), str) or not alias['currentName'].strip():
            raise ValueError('Display alias must preserve the captured source name')
    story = [para('BOSS线上简历摘要', title), para('非完整正文 · 仅保存接口已读到的线上简历字段', small),
             Spacer(1, 3 * mm), para(f"姓名：{c['name']}"), para(f"BOSS UID：{c['uid']}    岗位ID：{c['jobId']}"),
             para(f"资料采集时间：{source['capturedAt']}", small),
             para('本文件由已保存的BOSS线上简历结构化摘要生成，不是候选人邮件PDF，也不是BOSS原版完整简历导出。未读到的内容不补写，简历内容均为候选人自述。', small)]
    if alias:
        story.append(para(f"人才表姓名：{alias['currentName']}；线上采集显示名：{alias['sourceName']}。已按同一UID和岗位的原始资料核验显示名关系，未改写原线上资料。", small))
    for section, label in [('education', '教育经历'), ('work', '工作经历'), ('projects', '项目经历')]:
        story.append(para(label, heading))
        entries = snapshot['sections'].get(section, [])
        if not entries:
            story.append(para('本次线上摘要未提供条目。', small))
        for index, item in enumerate(entries, 1):
            fields = []
            for key, value in item.items():
                if key not in LABELS:
                    raise ValueError('Unexpected snapshot field: ' + key)
                text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
                fields.append(para(f"{LABELS[key]}：{text}"))
            if fields:
                if len(fields) <= 6:
                    story.append(KeepTogether(fields))
                else:
                    story.append(KeepTogether(fields[:2]))
                    story.extend(fields[2:])
                story.append(Spacer(1, 2 * mm))
    story.extend([Spacer(1, 5 * mm), para('来源原件SHA-256：', small), para(source['sha256'], small),
                  para('缺失说明：项目详细描述、未导出的经历或其他正文没有在本文件中补全。请结合BOSS原会话及HR复核。', small)])
    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont('ResumeCJK', 8)
        canvas.setFillColor(colors.HexColor('#65737e'))
        canvas.drawString(18 * mm, 11 * mm, 'BOSS线上简历摘要（非完整正文）')
        canvas.drawRightString(192 * mm, 11 * mm, str(doc.page))
        canvas.restoreState()
    # Exclusive creation prevents an interrupted run from overwriting prior evidence.
    with output.open('xb') as handle:
        doc = SimpleDocTemplate(handle, pagesize=(210 * mm, 297 * mm), leftMargin=18 * mm, rightMargin=18 * mm,
                                topMargin=17 * mm, bottomMargin=20 * mm, title=f"BOSS线上简历摘要 - {c['name']}", author='招聘资料归档')
        doc.build(story, onFirstPage=footer, onLaterPages=footer)
    return {'file': str(output), 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(), 'bytes': output.stat().st_size}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--font', type=Path, required=True)
    args = parser.parse_args()
    result = render(json.loads(args.input.read_text(encoding='utf-8')), args.output, args.font)
    print(json.dumps(result, ensure_ascii=False))
